"""Collects every tx('…') literal in src/ (Italian source) -> i18n/source.json"""
import re, json, pathlib, sys
ESC={'n':'\n','t':'\t','r':'\r','b':'\b','f':'\f','v':'\v','0':'\0'}
def parse(src,i):
    q=src[i]; j=i+1; out=[]
    while src[j]!=q:
        c=src[j]
        if c=='\\':
            d=src[j+1]
            if d=='u':
                if src[j+2]=='{': k=src.index('}',j); out.append(chr(int(src[j+3:k],16))); j=k+1; continue
                out.append(chr(int(src[j+2:j+6],16))); j+=6; continue
            if d=='x': out.append(chr(int(src[j+2:j+4],16))); j+=4; continue
            if d=='\n': j+=2; continue
            out.append(ESC.get(d,d)); j+=2; continue
        if q=='`' and c=='$' and src[j+1]=='{': return None,j
        out.append(c); j+=1
    return ''.join(out),j+1
strings=set(); dyn=[]
for f in sorted(pathlib.Path('src').rglob('*.ts')):
    if 'i18n' in f.parts: continue
    s=f.read_text()
    for m in re.finditer(r'(?<![\w$.])tx\(\s*',s):
        i=m.end()
        if s[i] in '\'"`':
            t,_=parse(s,i)
            if t is not None: strings.add(t); continue
        dyn.append(f'{f}:{s.count(chr(10),0,i)+1}: {s[m.start():m.start()+70]!r}')
json.dump(sorted(strings),open('i18n/source.json','w'),ensure_ascii=False,indent=0)
print('strings',len(strings),'chars',sum(map(len,strings)))
print('\n'.join(dyn))
