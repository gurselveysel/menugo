"""Apply reviewed line edits; only known source files, verified before and after."""
import json, hashlib, pathlib
root=pathlib.Path('.')
for change in json.loads(pathlib.Path('scripts/releases/platform-r29-edits.json').read_text()):
    p=root/change['path']
    raw=p.read_bytes()
    digest=hashlib.sha256(raw).hexdigest()
    if digest==change['after']:
        continue
    assert digest==change['sha256'], 'Base changed: '+str(p)
    lines=raw.decode('utf-8').splitlines(keepends=True)
    for start,end,replacement in reversed(change['edits']):
        lines[start:end]=[replacement]
    data=''.join(lines).encode('utf-8')
    assert hashlib.sha256(data).hexdigest()==change['after'], 'Output differs: '+str(p)
    p.write_bytes(data)
p=pathlib.Path('components/transport.ts')
s=p.read_text()
if 'PLATFORM_SERVICE_PAUSED:' not in s:
    s=s.replace('export const messages:Record<string,string>={','export const messages:Record<string,string>={PLATFORM_SERVICE_PAUSED:\'Bu hizmet şu anda kullanılamıyor. Mevcut siparişleriniz korunuyor.\',PLATFORM_SECURITY_SETTINGS_REQUIRED:\'Teknik güvenlik ayarları MenüGO şirket yönetimine aittir.\',',1)
    p.write_text(s)
p=pathlib.Path('app/platform/control.css')
s=p.read_text();marker='.pc-header p{margin:6px 0 0}'
if s.count(marker)==2:
    first=s.index(marker)+len(marker)
    s=s[:first]+s[first:].replace(marker,'',1)
    p.write_text(s)
expected=json.loads(pathlib.Path('scripts/releases/platform-r29-hashes.json').read_text())
for name,digest in expected.items():
    actual=hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()
    assert actual==digest, 'Reviewed source mismatch: '+name+' '+actual
print('ALL 23 REVIEWED FILE DIGESTS MATCH')
