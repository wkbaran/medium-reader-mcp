<!-- Source: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
     Fetched 2026-10-02 via Firecrawl (markdown, main content only). -->

Submit a Decisions request

cURL

    curl --request POST \
      --url https://openrouter.ai/api/alpha/decisions \
      --header 'Authorization: Bearer <token>' \
      --header 'Content-Type: application/json' \
      --data '
    {
      "model": "typesafe/jev-1.13",
      "questions": {
        "is_bug": {
          "criteria": {
            "false": "The customer is asking a question or requesting a feature.",
            "true": "The customer describes broken or unexpected product behavior."
          },
          "instructions": "Is the customer reporting a software defect?",
          "type": "noul"
        },
        "team": {
          "criteria": {
            "account": "Login, permissions, or profile issues.",
            "frontend": "Rendering, layout, or browser compatibility issues.",
            "payments": "Checkout, billing, or payment processing issues."
          },
          "instructions": "Which team should own this ticket?",
          "type": "choice"
        },
        "urgency": {
          "criteria": [\
            "Can wait for the next release",\
            "Should be fixed this week",\
            "Blocking revenue right now"\
          ],
          "instructions": "How urgent is this ticket?",
          "type": "score"
        }
      },
      "state": {
        "customer_tier": "enterprise",
        "ticket": "My checkout page shows a blank screen after I click Pay. I have tried two browsers."
      }
    }
    '

    import requests
    
    url = "https://openrouter.ai/api/alpha/decisions"
    
    payload = {
        "model": "typesafe/jev-1.13",
        "questions": {
            "is_bug": {
                "criteria": {
                    "false": "The customer is asking a question or requesting a feature.",
                    "true": "The customer describes broken or unexpected product behavior."
                },
                "instructions": "Is the customer reporting a software defect?",
                "type": "noul"
            },
            "team": {
                "criteria": {
                    "account": "Login, permissions, or profile issues.",
                    "frontend": "Rendering, layout, or browser compatibility issues.",
                    "payments": "Checkout, billing, or payment processing issues."
                },
                "instructions": "Which team should own this ticket?",
                "type": "choice"
            },
            "urgency": {
                "criteria": ["Can wait for the next release", "Should be fixed this week", "Blocking revenue right now"],
                "instructions": "How urgent is this ticket?",
                "type": "score"
            }
        },
        "state": {
            "customer_tier": "enterprise",
            "ticket": "My checkout page shows a blank screen after I click Pay. I have tried two browsers."
        }
    }
    headers = {
        "Authorization": "Bearer <token>",
        "Content-Type": "application/json"
    }
    
    response = requests.post(url, json=payload, headers=headers)
    
    print(response.text)

    const options = {
      method: 'POST',
      headers: {Authorization: 'Bearer <token>', 'Content-Type': 'application/json'},
      body: JSON.stringify({
        model: 'typesafe/jev-1.13',
        questions: {
          is_bug: {
            criteria: {
              false: 'The customer is asking a question or requesting a feature.',
              true: 'The customer describes broken or unexpected product behavior.'
            },
            instructions: 'Is the customer reporting a software defect?',
            type: 'noul'
          },
          team: {
            criteria: {
              account: 'Login, permissions, or profile issues.',
              frontend: 'Rendering, layout, or browser compatibility issues.',
              payments: 'Checkout, billing, or payment processing issues.'
            },
            instructions: 'Which team should own this ticket?',
            type: 'choice'
          },
          urgency: {
            criteria: [\
              'Can wait for the next release',\
              'Should be fixed this week',\
              'Blocking revenue right now'\
            ],
            instructions: 'How urgent is this ticket?',
            type: 'score'
          }
        },
        state: {
          customer_tier: 'enterprise',
          ticket: 'My checkout page shows a blank screen after I click Pay. I have tried two browsers.'
        }
      })
    };
    
    fetch('https://openrouter.ai/api/alpha/decisions', options)
      .then(res => res.json())
      .then(res => console.log(res))
      .catch(err => console.error(err));

    <?php
    
    $curl = curl_init();
    
    curl_setopt_array($curl, [\
      CURLOPT_URL => "https://openrouter.ai/api/alpha/decisions",\
      CURLOPT_RETURNTRANSFER => true,\
      CURLOPT_ENCODING => "",\
      CURLOPT_MAXREDIRS => 10,\
      CURLOPT_TIMEOUT => 30,\
      CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,\
      CURLOPT_CUSTOMREQUEST => "POST",\
      CURLOPT_POSTFIELDS => json_encode([\
        'model' => 'typesafe/jev-1.13',\
        'questions' => [\
            'is_bug' => [\
                    'criteria' => [\
                                    'false' => 'The customer is asking a question or requesting a feature.',\
                                    'true' => 'The customer describes broken or unexpected product behavior.'\
                    ],\
                    'instructions' => 'Is the customer reporting a software defect?',\
                    'type' => 'noul'\
            ],\
            'team' => [\
                    'criteria' => [\
                                    'account' => 'Login, permissions, or profile issues.',\
                                    'frontend' => 'Rendering, layout, or browser compatibility issues.',\
                                    'payments' => 'Checkout, billing, or payment processing issues.'\
                    ],\
                    'instructions' => 'Which team should own this ticket?',\
                    'type' => 'choice'\
            ],\
            'urgency' => [\
                    'criteria' => [\
                                    'Can wait for the next release',\
                                    'Should be fixed this week',\
                                    'Blocking revenue right now'\
                    ],\
                    'instructions' => 'How urgent is this ticket?',\
                    'type' => 'score'\
            ]\
        ],\
        'state' => [\
            'customer_tier' => 'enterprise',\
            'ticket' => 'My checkout page shows a blank screen after I click Pay. I have tried two browsers.'\
        ]\
      ]),\
      CURLOPT_HTTPHEADER => [\
        "Authorization: Bearer <token>",\
        "Content-Type: application/json"\
      ],\
    ]);
    
    $response = curl_exec($curl);
    $err = curl_error($curl);
    
    curl_close($curl);
    
    if ($err) {
      echo "cURL Error #:" . $err;
    } else {
      echo $response;
    }

    package main
    
    import (
    	"fmt"
    	"strings"
    	"net/http"
    	"io"
    )
    
    func main() {
    
    	url := "https://openrouter.ai/api/alpha/decisions"
    
    	payload := strings.NewReader("{\n  \"model\": \"typesafe/jev-1.13\",\n  \"questions\": {\n    \"is_bug\": {\n      \"criteria\": {\n        \"false\": \"The customer is asking a question or requesting a feature.\",\n        \"true\": \"The customer describes broken or unexpected product behavior.\"\n      },\n      \"instructions\": \"Is the customer reporting a software defect?\",\n      \"type\": \"noul\"\n    },\n    \"team\": {\n      \"criteria\": {\n        \"account\": \"Login, permissions, or profile issues.\",\n        \"frontend\": \"Rendering, layout, or browser compatibility issues.\",\n        \"payments\": \"Checkout, billing, or payment processing issues.\"\n      },\n      \"instructions\": \"Which team should own this ticket?\",\n      \"type\": \"choice\"\n    },\n    \"urgency\": {\n      \"criteria\": [\n        \"Can wait for the next release\",\n        \"Should be fixed this week\",\n        \"Blocking revenue right now\"\n      ],\n      \"instructions\": \"How urgent is this ticket?\",\n      \"type\": \"score\"\n    }\n  },\n  \"state\": {\n    \"customer_tier\": \"enterprise\",\n    \"ticket\": \"My checkout page shows a blank screen after I click Pay. I have tried two browsers.\"\n  }\n}")
    
    	req, _ := http.NewRequest("POST", url, payload)
    
    	req.Header.Add("Authorization", "Bearer <token>")
    	req.Header.Add("Content-Type", "application/json")
    
    	res, _ := http.DefaultClient.Do(req)
    
    	defer res.Body.Close()
    	body, _ := io.ReadAll(res.Body)
    
    	fmt.Println(string(body))
    
    }

    HttpResponse<String> response = Unirest.post("https://openrouter.ai/api/alpha/decisions")
      .header("Authorization", "Bearer <token>")
      .header("Content-Type", "application/json")
      .body("{\n  \"model\": \"typesafe/jev-1.13\",\n  \"questions\": {\n    \"is_bug\": {\n      \"criteria\": {\n        \"false\": \"The customer is asking a question or requesting a feature.\",\n        \"true\": \"The customer describes broken or unexpected product behavior.\"\n      },\n      \"instructions\": \"Is the customer reporting a software defect?\",\n      \"type\": \"noul\"\n    },\n    \"team\": {\n      \"criteria\": {\n        \"account\": \"Login, permissions, or profile issues.\",\n        \"frontend\": \"Rendering, layout, or browser compatibility issues.\",\n        \"payments\": \"Checkout, billing, or payment processing issues.\"\n      },\n      \"instructions\": \"Which team should own this ticket?\",\n      \"type\": \"choice\"\n    },\n    \"urgency\": {\n      \"criteria\": [\n        \"Can wait for the next release\",\n        \"Should be fixed this week\",\n        \"Blocking revenue right now\"\n      ],\n      \"instructions\": \"How urgent is this ticket?\",\n      \"type\": \"score\"\n    }\n  },\n  \"state\": {\n    \"customer_tier\": \"enterprise\",\n    \"ticket\": \"My checkout page shows a blank screen after I click Pay. I have tried two browsers.\"\n  }\n}")
      .asString();

    require 'uri'
    require 'net/http'
    
    url = URI("https://openrouter.ai/api/alpha/decisions")
    
    http = Net::HTTP.new(url.host, url.port)
    http.use_ssl = true
    
    request = Net::HTTP::Post.new(url)
    request["Authorization"] = 'Bearer <token>'
    request["Content-Type"] = 'application/json'
    request.body = "{\n  \"model\": \"typesafe/jev-1.13\",\n  \"questions\": {\n    \"is_bug\": {\n      \"criteria\": {\n        \"false\": \"The customer is asking a question or requesting a feature.\",\n        \"true\": \"The customer describes broken or unexpected product behavior.\"\n      },\n      \"instructions\": \"Is the customer reporting a software defect?\",\n      \"type\": \"noul\"\n    },\n    \"team\": {\n      \"criteria\": {\n        \"account\": \"Login, permissions, or profile issues.\",\n        \"frontend\": \"Rendering, layout, or browser compatibility issues.\",\n        \"payments\": \"Checkout, billing, or payment processing issues.\"\n      },\n      \"instructions\": \"Which team should own this ticket?\",\n      \"type\": \"choice\"\n    },\n    \"urgency\": {\n      \"criteria\": [\n        \"Can wait for the next release\",\n        \"Should be fixed this week\",\n        \"Blocking revenue right now\"\n      ],\n      \"instructions\": \"How urgent is this ticket?\",\n      \"type\": \"score\"\n    }\n  },\n  \"state\": {\n    \"customer_tier\": \"enterprise\",\n    \"ticket\": \"My checkout page shows a blank screen after I click Pay. I have tried two browsers.\"\n  }\n}"
    
    response = http.request(request)
    puts response.read_body

200

400

401

402

403

404

413

429

500

502

503

524

529

    {
      "answers": {
        "is_bug": {
          "noul": 0.96,
          "type": "noul"
        },
        "team": {
          "choice": "payments",
          "confidence": 0.75,
          "probabilities": {
            "account": 0,
            "frontend": 0.16,
            "payments": 0.84
          },
          "type": "choice"
        },
        "urgency": {
          "confidence": 0.99,
          "legend": {
            "0": "Can wait for the next release",
            "1": "Should be fixed this week",
            "2": "Blocking revenue right now"
          },
          "probabilities": {
            "0": 0,
            "1": 0.01,
            "2": 0.99
          },
          "score": 1.99,
          "type": "score"
        }
      },
      "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
      "model": "typesafe/jev-1.13-20260917",
      "provider": "TypeSafe",
      "usage": {
        "cost": 0.000019992,
        "input_tokens": 476,
        "output_tokens": 70
      }
    }

    {
      "error": {
        "code": 400,
        "message": "Invalid request parameters"
      }
    }

    {
      "error": {
        "code": 401,
        "message": "Missing Authentication header"
      }
    }

    {
      "error": {
        "code": 402,
        "message": "Insufficient credits. Add more using https://openrouter.ai/credits"
      }
    }

    {
      "error": {
        "code": 403,
        "message": "Only management keys can perform this operation"
      }
    }

    {
      "error": {
        "code": 404,
        "message": "Resource not found"
      }
    }

    {
      "error": {
        "code": 413,
        "message": "Request payload too large"
      }
    }

    {
      "error": {
        "code": 429,
        "message": "Rate limit exceeded"
      }
    }

    {
      "error": {
        "code": 500,
        "message": "Internal Server Error"
      }
    }

    {
      "error": {
        "code": 502,
        "message": "Provider returned error"
      }
    }

    {
      "error": {
        "code": 503,
        "message": "Service temporarily unavailable"
      }
    }

    {
      "error": {
        "code": 524,
        "message": "Request timed out. Please try again later."
      }
    }

    {
      "error": {
        "code": 529,
        "message": "Provider returned error"
      }
    }

POST

/

api

/

alpha

/

decisions

Try it

Submit a Decisions request

cURL

    curl --request POST \
      --url https://openrouter.ai/api/alpha/decisions \
      --header 'Authorization: Bearer <token>' \
      --header 'Content-Type: application/json' \
      --data '
    {
      "model": "typesafe/jev-1.13",
      "questions": {
        "is_bug": {
          "criteria": {
            "false": "The customer is asking a question or requesting a feature.",
            "true": "The customer describes broken or unexpected product behavior."
          },
          "instructions": "Is the customer reporting a software defect?",
          "type": "noul"
        },
        "team": {
          "criteria": {
            "account": "Login, permissions, or profile issues.",
            "frontend": "Rendering, layout, or browser compatibility issues.",
            "payments": "Checkout, billing, or payment processing issues."
          },
          "instructions": "Which team should own this ticket?",
          "type": "choice"
        },
        "urgency": {
          "criteria": [\
            "Can wait for the next release",\
            "Should be fixed this week",\
            "Blocking revenue right now"\
          ],
          "instructions": "How urgent is this ticket?",
          "type": "score"
        }
      },
      "state": {
        "customer_tier": "enterprise",
        "ticket": "My checkout page shows a blank screen after I click Pay. I have tried two browsers."
      }
    }
    '

    import requests
    
    url = "https://openrouter.ai/api/alpha/decisions"
    
    payload = {
        "model": "typesafe/jev-1.13",
        "questions": {
            "is_bug": {
                "criteria": {
                    "false": "The customer is asking a question or requesting a feature.",
                    "true": "The customer describes broken or unexpected product behavior."
                },
                "instructions": "Is the customer reporting a software defect?",
                "type": "noul"
            },
            "team": {
                "criteria": {
                    "account": "Login, permissions, or profile issues.",
                    "frontend": "Rendering, layout, or browser compatibility issues.",
                    "payments": "Checkout, billing, or payment processing issues."
                },
                "instructions": "Which team should own this ticket?",
                "type": "choice"
            },
            "urgency": {
                "criteria": ["Can wait for the next release", "Should be fixed this week", "Blocking revenue right now"],
                "instructions": "How urgent is this ticket?",
                "type": "score"
            }
        },
        "state": {
            "customer_tier": "enterprise",
            "ticket": "My checkout page shows a blank screen after I click Pay. I have tried two browsers."
        }
    }
    headers = {
        "Authorization": "Bearer <token>",
        "Content-Type": "application/json"
    }
    
    response = requests.post(url, json=payload, headers=headers)
    
    print(response.text)

    const options = {
      method: 'POST',
      headers: {Authorization: 'Bearer <token>', 'Content-Type': 'application/json'},
      body: JSON.stringify({
        model: 'typesafe/jev-1.13',
        questions: {
          is_bug: {
            criteria: {
              false: 'The customer is asking a question or requesting a feature.',
              true: 'The customer describes broken or unexpected product behavior.'
            },
            instructions: 'Is the customer reporting a software defect?',
            type: 'noul'
          },
          team: {
            criteria: {
              account: 'Login, permissions, or profile issues.',
              frontend: 'Rendering, layout, or browser compatibility issues.',
              payments: 'Checkout, billing, or payment processing issues.'
            },
            instructions: 'Which team should own this ticket?',
            type: 'choice'
          },
          urgency: {
            criteria: [\
              'Can wait for the next release',\
              'Should be fixed this week',\
              'Blocking revenue right now'\
            ],
            instructions: 'How urgent is this ticket?',
            type: 'score'
          }
        },
        state: {
          customer_tier: 'enterprise',
          ticket: 'My checkout page shows a blank screen after I click Pay. I have tried two browsers.'
        }
      })
    };
    
    fetch('https://openrouter.ai/api/alpha/decisions', options)
      .then(res => res.json())
      .then(res => console.log(res))
      .catch(err => console.error(err));

    <?php
    
    $curl = curl_init();
    
    curl_setopt_array($curl, [\
      CURLOPT_URL => "https://openrouter.ai/api/alpha/decisions",\
      CURLOPT_RETURNTRANSFER => true,\
      CURLOPT_ENCODING => "",\
      CURLOPT_MAXREDIRS => 10,\
      CURLOPT_TIMEOUT => 30,\
      CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,\
      CURLOPT_CUSTOMREQUEST => "POST",\
      CURLOPT_POSTFIELDS => json_encode([\
        'model' => 'typesafe/jev-1.13',\
        'questions' => [\
            'is_bug' => [\
                    'criteria' => [\
                                    'false' => 'The customer is asking a question or requesting a feature.',\
                                    'true' => 'The customer describes broken or unexpected product behavior.'\
                    ],\
                    'instructions' => 'Is the customer reporting a software defect?',\
                    'type' => 'noul'\
            ],\
            'team' => [\
                    'criteria' => [\
                                    'account' => 'Login, permissions, or profile issues.',\
                                    'frontend' => 'Rendering, layout, or browser compatibility issues.',\
                                    'payments' => 'Checkout, billing, or payment processing issues.'\
                    ],\
                    'instructions' => 'Which team should own this ticket?',\
                    'type' => 'choice'\
            ],\
            'urgency' => [\
                    'criteria' => [\
                                    'Can wait for the next release',\
                                    'Should be fixed this week',\
                                    'Blocking revenue right now'\
                    ],\
                    'instructions' => 'How urgent is this ticket?',\
                    'type' => 'score'\
            ]\
        ],\
        'state' => [\
            'customer_tier' => 'enterprise',\
            'ticket' => 'My checkout page shows a blank screen after I click Pay. I have tried two browsers.'\
        ]\
      ]),\
      CURLOPT_HTTPHEADER => [\
        "Authorization: Bearer <token>",\
        "Content-Type: application/json"\
      ],\
    ]);
    
    $response = curl_exec($curl);
    $err = curl_error($curl);
    
    curl_close($curl);
    
    if ($err) {
      echo "cURL Error #:" . $err;
    } else {
      echo $response;
    }

    package main
    
    import (
    	"fmt"
    	"strings"
    	"net/http"
    	"io"
    )
    
    func main() {
    
    	url := "https://openrouter.ai/api/alpha/decisions"
    
    	payload := strings.NewReader("{\n  \"model\": \"typesafe/jev-1.13\",\n  \"questions\": {\n    \"is_bug\": {\n      \"criteria\": {\n        \"false\": \"The customer is asking a question or requesting a feature.\",\n        \"true\": \"The customer describes broken or unexpected product behavior.\"\n      },\n      \"instructions\": \"Is the customer reporting a software defect?\",\n      \"type\": \"noul\"\n    },\n    \"team\": {\n      \"criteria\": {\n        \"account\": \"Login, permissions, or profile issues.\",\n        \"frontend\": \"Rendering, layout, or browser compatibility issues.\",\n        \"payments\": \"Checkout, billing, or payment processing issues.\"\n      },\n      \"instructions\": \"Which team should own this ticket?\",\n      \"type\": \"choice\"\n    },\n    \"urgency\": {\n      \"criteria\": [\n        \"Can wait for the next release\",\n        \"Should be fixed this week\",\n        \"Blocking revenue right now\"\n      ],\n      \"instructions\": \"How urgent is this ticket?\",\n      \"type\": \"score\"\n    }\n  },\n  \"state\": {\n    \"customer_tier\": \"enterprise\",\n    \"ticket\": \"My checkout page shows a blank screen after I click Pay. I have tried two browsers.\"\n  }\n}")
    
    	req, _ := http.NewRequest("POST", url, payload)
    
    	req.Header.Add("Authorization", "Bearer <token>")
    	req.Header.Add("Content-Type", "application/json")
    
    	res, _ := http.DefaultClient.Do(req)
    
    	defer res.Body.Close()
    	body, _ := io.ReadAll(res.Body)
    
    	fmt.Println(string(body))
    
    }

    HttpResponse<String> response = Unirest.post("https://openrouter.ai/api/alpha/decisions")
      .header("Authorization", "Bearer <token>")
      .header("Content-Type", "application/json")
      .body("{\n  \"model\": \"typesafe/jev-1.13\",\n  \"questions\": {\n    \"is_bug\": {\n      \"criteria\": {\n        \"false\": \"The customer is asking a question or requesting a feature.\",\n        \"true\": \"The customer describes broken or unexpected product behavior.\"\n      },\n      \"instructions\": \"Is the customer reporting a software defect?\",\n      \"type\": \"noul\"\n    },\n    \"team\": {\n      \"criteria\": {\n        \"account\": \"Login, permissions, or profile issues.\",\n        \"frontend\": \"Rendering, layout, or browser compatibility issues.\",\n        \"payments\": \"Checkout, billing, or payment processing issues.\"\n      },\n      \"instructions\": \"Which team should own this ticket?\",\n      \"type\": \"choice\"\n    },\n    \"urgency\": {\n      \"criteria\": [\n        \"Can wait for the next release\",\n        \"Should be fixed this week\",\n        \"Blocking revenue right now\"\n      ],\n      \"instructions\": \"How urgent is this ticket?\",\n      \"type\": \"score\"\n    }\n  },\n  \"state\": {\n    \"customer_tier\": \"enterprise\",\n    \"ticket\": \"My checkout page shows a blank screen after I click Pay. I have tried two browsers.\"\n  }\n}")
      .asString();

    require 'uri'
    require 'net/http'
    
    url = URI("https://openrouter.ai/api/alpha/decisions")
    
    http = Net::HTTP.new(url.host, url.port)
    http.use_ssl = true
    
    request = Net::HTTP::Post.new(url)
    request["Authorization"] = 'Bearer <token>'
    request["Content-Type"] = 'application/json'
    request.body = "{\n  \"model\": \"typesafe/jev-1.13\",\n  \"questions\": {\n    \"is_bug\": {\n      \"criteria\": {\n        \"false\": \"The customer is asking a question or requesting a feature.\",\n        \"true\": \"The customer describes broken or unexpected product behavior.\"\n      },\n      \"instructions\": \"Is the customer reporting a software defect?\",\n      \"type\": \"noul\"\n    },\n    \"team\": {\n      \"criteria\": {\n        \"account\": \"Login, permissions, or profile issues.\",\n        \"frontend\": \"Rendering, layout, or browser compatibility issues.\",\n        \"payments\": \"Checkout, billing, or payment processing issues.\"\n      },\n      \"instructions\": \"Which team should own this ticket?\",\n      \"type\": \"choice\"\n    },\n    \"urgency\": {\n      \"criteria\": [\n        \"Can wait for the next release\",\n        \"Should be fixed this week\",\n        \"Blocking revenue right now\"\n      ],\n      \"instructions\": \"How urgent is this ticket?\",\n      \"type\": \"score\"\n    }\n  },\n  \"state\": {\n    \"customer_tier\": \"enterprise\",\n    \"ticket\": \"My checkout page shows a blank screen after I click Pay. I have tried two browsers.\"\n  }\n}"
    
    response = http.request(request)
    puts response.read_body

200

400

401

402

403

404

413

429

500

502

503

524

529

    {
      "answers": {
        "is_bug": {
          "noul": 0.96,
          "type": "noul"
        },
        "team": {
          "choice": "payments",
          "confidence": 0.75,
          "probabilities": {
            "account": 0,
            "frontend": 0.16,
            "payments": 0.84
          },
          "type": "choice"
        },
        "urgency": {
          "confidence": 0.99,
          "legend": {
            "0": "Can wait for the next release",
            "1": "Should be fixed this week",
            "2": "Blocking revenue right now"
          },
          "probabilities": {
            "0": 0,
            "1": 0.01,
            "2": 0.99
          },
          "score": 1.99,
          "type": "score"
        }
      },
      "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
      "model": "typesafe/jev-1.13-20260917",
      "provider": "TypeSafe",
      "usage": {
        "cost": 0.000019992,
        "input_tokens": 476,
        "output_tokens": 70
      }
    }

    {
      "error": {
        "code": 400,
        "message": "Invalid request parameters"
      }
    }

    {
      "error": {
        "code": 401,
        "message": "Missing Authentication header"
      }
    }

    {
      "error": {
        "code": 402,
        "message": "Insufficient credits. Add more using https://openrouter.ai/credits"
      }
    }

    {
      "error": {
        "code": 403,
        "message": "Only management keys can perform this operation"
      }
    }

    {
      "error": {
        "code": 404,
        "message": "Resource not found"
      }
    }

    {
      "error": {
        "code": 413,
        "message": "Request payload too large"
      }
    }

    {
      "error": {
        "code": 429,
        "message": "Rate limit exceeded"
      }
    }

    {
      "error": {
        "code": 500,
        "message": "Internal Server Error"
      }
    }

    {
      "error": {
        "code": 502,
        "message": "Provider returned error"
      }
    }

    {
      "error": {
        "code": 503,
        "message": "Service temporarily unavailable"
      }
    }

    {
      "error": {
        "code": 524,
        "message": "Request timed out. Please try again later."
      }
    }

    {
      "error": {
        "code": 529,
        "message": "Provider returned error"
      }
    }

#### Authorizations


Authorization

string

header

required

API key as bearer token in Authorization header

#### Body

application/json


model

string

required


questions

object

required

Show child attributes


state

stringobjectany\[\]stringobjectany\[\]

required

The content to evaluate: a plain string, or a JSON object or array of related context.


provider

object | null

Provider routing preferences for the request.

Show child attributes

Example:

`{ "allow_fallbacks": true }`


session\_id

string

A unique identifier for grouping related requests (e.g., a conversation or agent workflow). Used for observability grouping in Broadcast and private logging; never sent to the provider. If provided in both the request body and the x-session-id header, the body value takes precedence. Maximum of 256 characters.

Maximum string length: `256`

Example:

`"session-1234"`


trace

object

Metadata for observability and tracing. Known keys (trace\_id, trace\_name, span\_name, generation\_name, parent\_span\_id) have special handling. Additional keys are passed through as custom metadata to configured broadcast destinations.

Show child attributes

Example:

`{     "trace_id": "trace-abc123",     "trace_name": "my-app-trace"   }`


user

string

Maximum string length: `256`

#### Response

200

application/json

Decisions response


answers

object

required

Show child attributes


model

string

required


usage

object

required

Show child attributes


id

string


provider

string
