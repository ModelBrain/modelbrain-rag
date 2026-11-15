#!/bin/bash
# Double-click to open ModelBrain RAG in your browser. If it is not set to
# start when you sign in yet (for example on a second account on this Mac),
# this sets that up first.
DIR="/Library/Application Support/ModelBrain RAG"
RAG() { "$DIR/node" "$DIR/app/bin/modelbrain-rag.js" "$@"; }
if ! RAG service status | /usr/bin/grep -q "yes"; then
  RAG service install || { echo; echo "Could not start ModelBrain RAG. The message above says why."; exit 1; }
fi
RAG open
