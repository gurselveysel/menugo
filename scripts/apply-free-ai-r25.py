"""Transfer reviewed, public source changes into the isolated feature branch.
No production credentials or external inference calls. The patch is immutable by SHA256;
all resulting source changes are committed visibly and tested before any main merge.
The signed transfer URL expires; successful expansion makes reruns independent of it.
"""
import hashlib
import pathlib
import subprocess
import urllib.request

marker = pathlib.Path('supabase/migrations/20260919233000_ops_free_ai_control.sql')
if marker.exists():
    print('Source patch already expanded; test the committed source.')
    raise SystemExit(0)
url = 'https://sdmntpritalynorth.oaiusercontent.com/files/00000000-fbac-8246-8040-b2fa7397cf93/raw?se=2026-09-19T20%3A21%3A10Z&sp=r&sv=2026-02-06&sr=b&scid=a0a8da7b-2d5b-56e1-9620-5348c7bd8761&skoid=82a3371f-2f6c-4f81-8a78-2701b362559b&sktid=a48cca56-e6da-484e-a814-9c849652bcb3&skt=2026-09-19T08%3A46%3A53Z&ske=2026-09-20T08%3A46%3A53Z&sks=b&skv=2026-02-06&sig=P5etYOGpiP4qmwOXRN75lY9AmjbDvC40qlpodVdfUp4%3D'
with urllib.request.urlopen(url, timeout=30) as response:
    patch = response.read(500001)
if len(patch) > 500000 or hashlib.sha256(patch).hexdigest() != '14fe7729802e0fd99055b142f19113c7ac45a6a420b5f0f5dbf26422d690a598':
    raise RuntimeError('SOURCE_PATCH_INTEGRITY_FAILED')
subprocess.run(['git', 'apply', '--check', '-'], input=patch, check=True)
subprocess.run(['git', 'apply', '-'], input=patch, check=True)
print('Reviewed patch applied; provider calls still require owner-supplied Free account keys.')
