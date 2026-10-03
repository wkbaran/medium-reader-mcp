<!-- Source: https://docs.typesafe.ai/confidence
     Fetched 2026-10-02 via Firecrawl (markdown, main content only). -->

All Score and Choice answers from TypeSafe include a `probabilities` property representing the probability distribution across the options (for Choice) or levels (for Score). The _shape_ of that distribution is what tells you how certain the model is: concentrated on one outcome means a confident answer, spread out means an uncertain one. The answer’s `confidence` property collapses that shape into a single number from 0 to 1, so you can threshold on it without doing the math yourself. It is 1 when all the probability is on one outcome and 0 when the probability is spread evenly. (Noul answers don’t carry one; see [Noul](https://docs.typesafe.ai/confidence#noul)
 below.)


Confidence is derived from the probabilities
-------------------------------------------------------------------------------------------------------------------------------------

`confidence` is a statistic computed from the probability distribution the answer already gives you. TypeSafe computes it for you and returns it on every Choice and Score answer, so the common case needs no extra work on your side.

Choice question with three options

See how probability distribution changes confidence

Confidence

0.85

Probability

0%

50%

100%

90%

A

6%

B

4%

C

A

90%

B

6%

C

4%

Move a slider to change an option's probability. The other probabilities adjust to keep the total at 100%.

Clear winnerSpread outEven split

Selected: Option A

How this demo calculates Confidence

TypeSafe computes confidence from how the probability is spread across the options. All of it on one option gives 1.0; the more evenly it spreads, the lower the confidence. With three options, the [Choice formula](https://docs.typesafe.ai/confidence#choice)
 is `(3 × largest probability − 1) / 2`, which is what this demo shows.

For a [Choice](https://docs.typesafe.ai/primitives/choice)
, the distribution is `probabilities` across your options. For a [Score](https://docs.typesafe.ai/primitives/score)
, it is the distribution across your levels. In both cases a flatter distribution means lower confidence: low confidence on a Choice often means none of the options are a clear winner over the others, and low confidence on a Score often means the levels are ambiguous, multi-dimensional, or the state doesn’t contain enough to go on. The exact formula for each question type is in [How confidence is calculated](https://docs.typesafe.ai/confidence#how-confidence-is-calculated)
, so you can see how any `confidence` value follows from the answer’s own `probabilities`.


”I don’t know” is a useful signal
---------------------------------------------------------------------------------------------------------------------------------------

If an intelligent system, whether human or machine, cannot express honest uncertainty, the system cannot be trusted. Confidence gives you a built-in mechanism for the model to say “I’m not sure about this one.” This lets your code implement different behavior for different levels of certainty, which is the foundation for building systems you can actually rely on.


Three paths for using confidence in your code
---------------------------------------------------------------------------------------------------------------------------------------

A useful starting pattern is to divide confidence into three ranges, each producing a different system behavior: **High confidence:** Act automatically. The model has a clear read and you can proceed without human involvement. **Medium confidence:** Proceed with caution. The model has a reasonable answer but is not certain. Depending on context, you might ask the user to confirm, flag for review, or gather more information before acting. **Low confidence:** Do not act. Route to a human, request clarification, or fall back to a different system. The model is telling you it does not have enough information or the question is not a good fit. Where you draw those boundaries depends on the stakes.


Thresholds scale with risk
-------------------------------------------------------------------------------------------------

A confidence threshold is not one number. Different actions within the same system should be gated at different levels depending on the consequences of getting it wrong.

    response = client.system_one(
        state=user_message,
        questions={
            "action": Choice(
                instructions="What is the user trying to do?",
                criteria={
                    "check_balance": "View account balance",
                    "approve_transfer": "Approve the pending withdrawal request",
                    "support": "Get help with an issue",
                },
            ),
        },
    )
    
    action = response.answers["action"]
    confidence = action.confidence
    
    if confidence < 0.5:
        # Model is genuinely unsure. Don't guess.
        route_to_human(user_message)
    
    elif action.choice == "check_balance":
        # Low stakes. Showing the wrong screen is recoverable.
        show_balance(account_id)
    
    elif action.choice == "approve_transfer":
        if confidence > 0.9:
            # High stakes, high confidence. Proceed with confirmation.
            confirm_then_execute(account_id)
        else:
            # High stakes, moderate confidence. Verify first.
            ask_user_to_confirm(account_id)
    

The 0.5 confidence floor catches anything the model reports as genuinely uncertain. Above that, the threshold for acting without confirmation is higher for a destructive operation than for a read-only one. Your code encodes the risk tolerance.

The correct threshold values depend on your domain and the performance of the model for your use case. Start with conservative thresholds, test with your own data, and adjust as you observe results.


How confidence is calculated
-----------------------------------------------------------------------------------------------------

Each question type summarizes its distribution a little differently. A Noul has two outcomes, a Choice has any number of options in no particular order, and a Score’s levels are ordered, so each formula below builds on the one before it. TypeSafe’s `confidence` is one reasonable way to summarize a distribution, not the only one. We return a fixed measure so that every answer comes with a sensible default: you can gate on `confidence` from your first call, on the same 0 to 1 scale for every question, without first choosing and validating a statistic of your own. Because the formulas below are exact and every answer includes its full `probabilities`, you can compute whichever measure matters most to your application instead.

### 


Noul

A Noul answer is a single probability ppp that the answer is yes, and TypeSafe returns no separate `confidence` for it. The probability already carries the uncertainty: a value near 0.5 is the model saying it is unsure, and the [Noul](https://docs.typesafe.ai/primitives/noul)
 page covers how to threshold on it directly. If you want a confidence-style number anyway, for example to gate Nouls and Choices with the same code, use the distance from 0.5: confidence\=∣2p−1∣\\text{confidence} = |2p - 1|confidence\=∣2p−1∣ This gives 0 at p\=0.5p = 0.5p\=0.5 and 1 at p\=0p = 0p\=0 or p\=1p = 1p\=1. It is also the Choice formula below applied to a yes-or-no Choice, so it sits on the same scale as Choice confidence.

### 


Choice

A Choice extends the same idea to any number of options. For a Choice with nnn options, where pmax⁡p\_{\\max}pmax​ is the probability of the selected option: confidence\=pmax⁡−1n1−1n\\text{confidence} = \\frac{p\_{\\max} - \\frac{1}{n}}{1 - \\frac{1}{n}}confidence\=1−n1​pmax​−n1​​ This measures how far the top probability sits above an even split of 1n\\frac{1}{n}n1​ per option, on a scale where the even split is 0 and certainty is 1. Only the top probability counts, so (0.6,0.3,0.1)(0.6, 0.3, 0.1)(0.6,0.3,0.1) and (0.6,0.2,0.2)(0.6, 0.2, 0.2)(0.6,0.2,0.2) both have confidence 0.4.

    def choice_confidence(probabilities: list[float]) -> float:
        n = len(probabilities)
        return (max(probabilities) - 1 / n) / (1 - 1 / n)
    
    
    choice_confidence(list(answer.probabilities.values()))
    

The [explorer at the top of this page](https://docs.typesafe.ai/confidence#confidence-is-derived-from-the-probabilities)
 uses this formula with three options. Two simpler measures, computed from the same `probabilities`, are often very effective in practice and are worth trying alongside `confidence`:

*   **Top probability**, pmax⁡p\_{\\max}pmax​. It reads directly as “how likely is the selected option”, which makes thresholds easy to reason about. Its meaning depends on the number of options, since 0.5 is a weak answer among two options and a strong one among ten, so set its threshold per question.
*   **Top-to-second ratio**, pmax⁡/psecondp\_{\\max} / p\_{\\text{second}}pmax​/psecond​. It measures how clearly the selected option beats the runner-up and ignores how the rest is spread. Many real decisions come down to the top two candidates, and this ratio targets exactly that.

### 


Score

A Score’s levels are ordered, so its formula also counts how far probability sits from the most likely level. For a Score with nnn levels numbered 000 to n−1n - 1n−1, where pip\_ipi​ is the probability of level iii and mmm is the most likely level: confidence\=max⁡(0, 1−∑ipi ∣i−m∣MADunif)MADunif\=1n∑i∣i−n−12∣\\text{confidence} = \\max\\left(0,\\ 1 - \\frac{\\sum\_i p\_i \\, |i - m|}{\\text{MAD}\_{\\text{unif}}}\\right) \\qquad \\text{MAD}\_{\\text{unif}} = \\frac{1}{n} \\sum\_i \\left| i - \\frac{n - 1}{2} \\right|confidence\=max(0, 1−MADunif​∑i​pi​∣i−m∣​)MADunif​\=n1​i∑​​i−2n−1​​ The sum in the numerator is the probability-weighted average distance, in levels, between the answer and the most likely level. MADunif\\text{MAD}\_{\\text{unif}}MADunif​ is the same kind of average distance for an even spread across all levels, measured from the middle level. Confidence compares the two, and is floored at 0 when the answer is at least as spread out as an even spread. Probability on a neighboring level lowers confidence less than the same probability on a level further away. With three levels, (0,0.5,0.5)(0, 0.5, 0.5)(0,0.5,0.5) has confidence 0.25, because the model is torn between two adjacent levels. (0.5,0,0.5)(0.5, 0, 0.5)(0.5,0,0.5) has confidence 0, because it is torn between opposite ends. The Choice formula would give both distributions 0.25.

Score question with five levels

See how distance between levels changes confidence

Confidence

0.92

Probability

0%

50%

100%

0%

02 away

5%

11 away

90%

2peak

5%

31 away

0%

42 away

0

0%

1

5%

2

90%

3

5%

4

0%

Move a slider to change a level's probability. The other probabilities adjust to keep the total at 100%.

Clear peakSplit between neighborsSplit between endsEven spread

Score

2.00

Choice formula on the same probabilities

0.88

How this demo calculates Confidence

This demo uses the [Score formula](https://docs.typesafe.ai/confidence#score)
. It takes the average distance, in levels, between the answer and the peak, weighted by probability. It divides that by 1.2, the same average for an even spread over five levels measured from the middle level, and subtracts the result from 1, stopping at 0. Probability on a level next to the peak lowers confidence less than probability far from it, which the Choice formula does not take into account.

    def score_confidence(probabilities: list[float]) -> float:
        n = len(probabilities)
        m = probabilities.index(max(probabilities))
        spread = sum(p * abs(i - m) for i, p in enumerate(probabilities))
        even_spread = sum(abs(i - (n - 1) / 2) for i in range(n)) / n
        return max(0.0, 1 - spread / even_spread)
    
    
    levels = sorted(answer.probabilities)
    score_confidence([answer.probabilities[level] for level in levels])
    

The `bug_severity` answer in the [Score response example](https://docs.typesafe.ai/primitives/score#response-structure)
 has probabilities (0,0.57,0.43)(0, 0.57, 0.43)(0,0.57,0.43). The most likely level is 1, the spread is 0.430.430.43, and MADunif\\text{MAD}\_{\\text{unif}}MADunif​ for three levels is 23\\frac{2}{3}32​, so confidence is 1−0.43/23≈0.351 - 0.43 / \\frac{2}{3} \\approx 0.351−0.43/32​≈0.35.
