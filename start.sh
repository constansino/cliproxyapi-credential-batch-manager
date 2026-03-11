#!/bin/bash
cd "$(dirname "$0")" || exit 1
PYTHONPATH=src python3 -m cliproxy_credman --menu