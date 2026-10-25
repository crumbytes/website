# CrumByte Technologies

Official website for crumbyte.com. Vercel hosting; Cloudflare DNS.

Contact form endpoint requires Vercel environment variables `RESEND_API_KEY` and `CONTACT_FROM_EMAIL` (verified Resend sender). Never commit API keys.

## SEO maintenance

Run `python scripts/check-seo.py` before publishing. Public pages use server-delivered HTML, unique titles and descriptions, self-referencing canonical URLs, social sharing metadata, and Organization/WebSite/WebPage JSON-LD. Service pages also describe their service in JSON-LD. Keep markup consistent with visible content; do not invent reviews, business hours, or street addresses.

`sitemap.xml` includes the 12 public pages. Update it when public pages are added or removed. `robots.txt` advertises the sitemap. Admin and portal preview pages use `noindex`; this is a search directive, not authentication. Keep them crawlable so search engines can read that directive. The canonical hostname is `crumbyte.com`; `www` permanently redirects to it.

External account setup remains unverified and is not completed by these code changes:

- Verify the domain in Google Search Console and Bing Webmaster Tools, then submit `https://crumbyte.com/sitemap.xml` in both.
- Connect the chosen analytics property and track confirmed contact/support submissions, telephone clicks, and email clicks. Count successful form responses, not button presses, as submitted leads. Never send names, email addresses, messages, device IDs, or other customer data to analytics.
- Set up or verify Google Business Profile if the business qualifies. Confirm public service areas, business hours, and contact details before publishing them. Do not expose a home address without the owner's direction.
- Use PageSpeed Insights and Search Console Core Web Vitals for ongoing performance checks. Inspect mobile navigation and forms after layout changes.

No paid SEO subscription or unverified analytics/verification ID is embedded. Google/Bing ownership, indexing, real-user performance, rankings, and lead reporting must be checked in their respective services after connection.
