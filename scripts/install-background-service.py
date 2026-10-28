"""Install the current checkout as a per-user macOS launch agent. No secrets in plist."""
import os
import pathlib
import plistlib
import shutil
import subprocess
import time

root = pathlib.Path(__file__).resolve().parents[1]
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js was not found')
label = 'com.maomao.sayright.tutor'
plist_path = pathlib.Path.home() / 'Library/LaunchAgents' / (label + '.plist')
log_dir = pathlib.Path.home() / 'Library/Logs/SayRight'
runtime = pathlib.Path.home() / 'Library/Application Support/SayRight/runtime'
runtime.mkdir(parents=True, exist_ok=True)
os.chmod(runtime, 0o700)
# Launch agents run from Application Support rather than a Desktop checkout.
for item in root.iterdir():
    if item.suffix in {'.js', '.mjs', '.html', '.css', '.webmanifest'} or item.name == '.env':
        target = runtime / item.name
        shutil.copy2(item, target)
        if item.name == '.env':
            os.chmod(target, 0o600)
for folder in ('images', 'icons', 'vendor'):
    shutil.copytree(root / folder, runtime / folder, dirs_exist_ok=True)
plist_path.parent.mkdir(parents=True, exist_ok=True)
log_dir.mkdir(parents=True, exist_ok=True)
config = {
    'Label': label,
    'ProgramArguments': [node, str(runtime / 'tutor-server.mjs')],
    'WorkingDirectory': str(runtime),
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 15,
    'EnvironmentVariables': {'PORT': '48773', 'TUTOR_HOST': '127.0.0.1'},
    'StandardOutPath': str(log_dir / 'tutor.stdout.log'),
    'StandardErrorPath': str(log_dir / 'tutor.stderr.log'),
}
with plist_path.open('wb') as handle:
    plistlib.dump(config, handle)
os.chmod(plist_path, 0o600)
domain = f'gui/{os.getuid()}'
subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
for attempt in range(5):
    result = subprocess.run(['launchctl', 'bootstrap', domain, str(plist_path)], capture_output=True)
    if result.returncode == 0:
        break
    time.sleep(0.5)
else:
    raise SystemExit('Could not register launch agent; retry after checking launchctl status')
subprocess.run(['launchctl', 'kickstart', f'{domain}/{label}'], check=True)
print(f'Installed {label} on 127.0.0.1:48773')
print(f'Launch agent: {plist_path}')
print(f'Logs: {log_dir}')
