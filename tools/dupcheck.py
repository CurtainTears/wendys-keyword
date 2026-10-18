import re, collections, io
s = io.open('index.html', encoding='utf-8').read()
i = s.find('const BANK=')
j = s.find('/* ================= state', i)
seg = s[i:j]
# 按 basic/mid/hard 分段
parts = re.split(r'\n\s*(basic|mid|hard)\s*:\s*\[', seg)
for k in range(1, len(parts), 2):
    name = parts[k]
    body = parts[k + 1]
    ens = re.findall(r'\{en:"([^"]+)"', body)
    c = collections.Counter(ens)
    d = [w for w, v in c.items() if v > 1]
    print(name, len(ens), 'dupes:', d)
