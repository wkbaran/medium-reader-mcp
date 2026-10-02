#!/bin/sh
# Cron pre-run script for the medium-digest skill. Its output is added to the top of the
# agent's prompt. The server keeps its own clock for state, so this only gives the date.
date -u +"Today's real date is %Y-%m-%d (%A), UTC."
