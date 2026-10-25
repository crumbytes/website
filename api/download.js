// Resolves the newest stable RustDesk installer by customer-selected device.
// This endpoint does not execute installers or accept arbitrary download URLs.
module.exports = async function handler(req, res) {
  const os = String(req.query.os || "").toLowerCase();
  const supported = new Set(["windows","mac","android","linux"]);
  res.setHeader("Cache-Control","no-store");
  if (!supported.has(os)) return res.status(400).send("Unsupported device.");
  try {
    const response = await fetch("https://api.github.com/repos/rustdesk/rustdesk/releases/latest", {
      headers: {"Accept":"application/vnd.github+json","User-Agent":"CrumByte-Support-Download"}
    });
    if (!response.ok) throw new Error("Release lookup failed");
    const release = await response.json();
    if (!Array.isArray(release.assets)) throw new Error("Missing release assets");
    const agents = {"windows":/\.exe$/i,"mac":/\.dmg$/i,"android":/\.apk$/i,"linux":/\.AppImage$/i};
    const candidates = release.assets.filter(a=>agents[os].test(a.name||""));
    function score(a) {
      const n=a.name.toLowerCase();let pts=0;
      if (/x86_64|x64|amd64/.test(n)) pts+=100;
      if (os==="mac" && /universal/.test(n)) pts+=180;
      if (os==="android" && /universal/.test(n)) pts+=180;
      if (os==="android" && /signed/.test(n)) pts+=20;
      if (/aarch64|arm64|armv7|x86-32|i686|legacy|sciter/.test(n)) pts-=140;
      if (/portable/.test(n)) pts-=10;
      return pts;
    }
    candidates.sort((a,b)=>score(b)-score(a));
    const asset=candidates[0];
    if(!asset || !asset.browser_download_url || !asset.browser_download_url.startsWith("https://github.com/rustdesk/rustdesk/releases/download/"))
      throw new Error("No official installer found");
    return res.redirect(302,asset.browser_download_url);
  } catch(error) {
    return res.status(503).send("The official installer is temporarily unavailable. Please call 808-285-7724 or email support@crumbyte.com for help.");
  }
};
