#!/bin/sh
# Cron pre-run script for the medium-digest skill. Its output is added to the top of the
# agent's prompt, giving the run an exact start time to save as last_run.
date -u +"Today's real date is %Y-%m-%d (%A), UTC.
RUN_STARTED_AT=%Y-%m-%dT%H:%M:%SZ (exact UTC start time of this run; save this value as last_run)"
