"""Expand the immutable source patch stored in this Git tree; no network access.
The feature-branch workflow commits the resulting reviewable source and runs acceptance.
"""
import base64
import hashlib
import lzma
import pathlib
import subprocess

marker = pathlib.Path('supabase/migrations/20260919233000_ops_free_ai_control.sql')
if marker.exists():
    print('Source patch already expanded; testing committed source.')
    raise SystemExit(0)
root = pathlib.Path('scripts/release-patches')
encoded = ''.join((root / f'free-ai-r25.{i}.b64').read_text().strip() for i in range(1, 4))
blob = base64.b64decode(encoded, validate=True)
if hashlib.sha256(blob).hexdigest() != 'f9b5c42674aea9c08e3628770e7f85ecc7de16368a0ec5ea57f7a1af51cd65fd':
    raise RuntimeError('SOURCE_PATCH_INTEGRITY_FAILED')
patch = lzma.decompress(blob, memlimit=128 * 1024 * 1024)
if len(patch) > 250000:
    raise RuntimeError('SOURCE_PATCH_TOO_LARGE')
subprocess.run(['git', 'apply', '--check', '--unidiff-zero', '-'], input=patch, check=True)
subprocess.run(['git', 'apply', '--unidiff-zero', '-'], input=patch, check=True)
print('Source expanded; external inference still requires owner-configured free credentials.')
