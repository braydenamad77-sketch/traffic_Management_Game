import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appName = 'GRIDLOCK';
const desktopApp = path.join(os.homedir(), 'Desktop', `${appName}.app`);
const contentsDir = path.join(desktopApp, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');
const launcherPath = path.join(macosDir, appName);
const iconSource = path.join(root, 'assets', 'icon.icns');
const iconDest = path.join(resourcesDir, 'icon.icns');

fs.rmSync(desktopApp, { recursive: true, force: true });
fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });
fs.copyFileSync(iconSource, iconDest);

const escapedRoot = root.replace(/"/g, '\\"');
const launcher = `#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "${escapedRoot}" || exit 1
mkdir -p "$HOME/Library/Logs"
(
  echo "[$(/bin/date)] Launching ${appName} from ${escapedRoot}"
  /usr/bin/env npm install --silent
  /usr/bin/env npm run electron:live
) >> "$HOME/Library/Logs/${appName}.log" 2>&1 &
exit 0
`;

fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>local.gridlock.live</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;

fs.writeFileSync(path.join(contentsDir, 'Info.plist'), plist);
fs.writeFileSync(path.join(contentsDir, 'PkgInfo'), 'APPL????');

console.log(`Created ${desktopApp}`);
