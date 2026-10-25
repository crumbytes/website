"""Check the static site's SEO contract before deployment. Run with Python 3."""
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://crumbyte.com'
PRIVATE = {'admin', 'portal'}


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.tags = []
        self.ids = set()
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        self.tags.append((tag, data))
        if 'id' in data:
            self.ids.add(data['id'])


pages = {p.name: (p.read_text(), Page(p.read_text())) for p in ROOT.glob('*.html')}
expected_urls = set()
descriptions = set()
titles = set()
script_count = 0
for name, (source, page) in pages.items():
    stem = Path(name).stem
    meta = {attrs.get('name', attrs.get('property')): attrs.get('content')
            for tag, attrs in page.tags if tag == 'meta'}
    if stem in PRIVATE:
        assert 'noindex' in meta.get('robots', ''), name
        continue
    url = ORIGIN + ('/' if stem == 'index' else '/' + stem)
    expected_urls.add(url)
    assert 'noindex' not in meta.get('robots', ''), name
    assert sum(tag == 'h1' for tag, _ in page.tags) == 1, name
    title = re.findall(r'<title>(.*?)</title>', source)
    assert len(title) == 1 and title[0] not in titles, name
    titles.add(title[0])
    assert meta.get('description') and meta['description'] not in descriptions, name
    descriptions.add(meta['description'])
    canonicals = [a['href'] for t, a in page.tags if t == 'link' and a.get('rel') == 'canonical']
    assert canonicals == [url], (name, canonicals)
    assert meta.get('og:url') == url and meta.get('og:title') and meta.get('og:description'), name
    assert meta.get('twitter:card') == 'summary', name
    graphs = re.findall(r'<script type="application/ld\+json">(.*?)</script>', source, re.S)
    assert len(graphs) == 1, name
    graph = json.loads(graphs[0])['@graph']
    assert any(node['@type'] == 'Organization' for node in graph), name
    assert any(node['@type'] == 'WebPage' and node['url'] == url for node in graph), name
    scripts = re.findall(r'<script(?![^>]*type="application/ld\+json")[^>]*>(.*?)</script>', source, re.S)
    assert len(scripts) == len(set(scripts)), name
    script_count += len(scripts)
    for tag, attrs in page.tags:
        if tag == 'img':
            assert attrs.get('alt') and attrs.get('width') and attrs.get('height'), name
            assert attrs.get('srcset') and attrs.get('sizes'), name
        if tag != 'a' or not attrs.get('href'):
            continue
        link = urlsplit(attrs['href'])
        if link.scheme or link.netloc or link.path.startswith('/api/'):
            continue
        target = (link.path.strip('/') or 'index') if link.path else name
        if not Path(target).suffix:
            target += '.html'
        assert target in pages, (name, attrs['href'])
        if link.fragment:
            assert unquote(link.fragment) in pages[target][1].ids, (name, attrs['href'])

ns = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
tree = ET.parse(ROOT / 'sitemap.xml')
urls = [loc.text for loc in tree.findall('s:url/s:loc', ns)]
assert len(urls) == len(set(urls)) and set(urls) == expected_urls
robots = (ROOT / 'robots.txt').read_text()
assert 'Sitemap: ' + ORIGIN + '/sitemap.xml' in robots
assert not any('Disallow: /' + path in robots for path in PRIVATE)
config = json.loads((ROOT / 'vercel.json').read_text())
assert config['cleanUrls'] and config['trailingSlash'] is False
assert any(r.get('destination') == ORIGIN + '/:path*' for r in config['redirects'])
print(f'PASS: {len(expected_urls)} public pages, sitemap, metadata, JSON-LD, images, and internal links; {len(PRIVATE)} noindex pages; {script_count} inline scripts.')
