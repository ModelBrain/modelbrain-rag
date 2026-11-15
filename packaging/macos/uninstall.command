#!/bin/bash
# Double-click to remove ModelBrain RAG. Your documents folder and your
# settings, users and keys are left alone.
DIR="/Library/Application Support/ModelBrain RAG"
MINE="$HOME/Library/Application Support/ModelBrain RAG"

if [ -x "$DIR/node" ]; then
  "$DIR/node" "$DIR/app/bin/modelbrain-rag.js" service uninstall
fi
/bin/rm -f "$MINE/setup-code" "$MINE"/open-setup-*.html "$MINE/server.log"

echo
echo "To remove the program files, macOS will ask for your password."
if /usr/bin/sudo /bin/rm -rf "$DIR"; then
  /usr/bin/sudo /usr/sbin/pkgutil --forget net.modelbrain.rag >/dev/null 2>&1
  echo "Removed. Your documents (~/ModelBrain RAG) and settings were not touched."
  echo "If other accounts on this Mac used ModelBrain RAG, each should remove"
  echo "~/Library/LaunchAgents/net.modelbrain.rag.plist and sign out and in."
else
  echo "The program files were NOT removed (the password step did not finish)."
  echo "ModelBrain RAG is stopped for your account. Run this again to finish."
  exit 1
fi
