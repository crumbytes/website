// Carries over the look of the website-management.html prototype. Served as one
// same-origin file so the Content-Security-Policy can forbid inline styles.
export const HUB_CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#eaf2ff;background:#08111f;font-synthesis:none;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#08111f}
a{color:#8ad9ee}a:hover{color:#c4f1fb}
button,input,select,textarea{font:inherit}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #60d9ec;outline-offset:2px}
.app{display:grid;grid-template-columns:258px minmax(0,1fr);min-height:100vh}
.sidebar{border-right:1px solid #243449;background:#0c1728;padding:30px 18px;display:flex;flex-direction:column;gap:28px}
.brand{display:flex;gap:12px;align-items:center;padding:0 12px;color:inherit;text-decoration:none}
.brandmark{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;background:linear-gradient(145deg,#27cee6,#2362d8);font-size:22px;font-weight:900;color:#fff}
.brand strong{display:block;font-size:17px}.brand small{color:#94a9c5;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.nav{display:grid;gap:4px}.nav a{display:block;color:#a8bbd1;text-decoration:none;border:1px solid transparent;border-radius:11px;padding:11px 13px;font-size:14px}
.nav a:hover{background:#17283c;color:#fff}.nav a[aria-current=page]{background:#143557;border-color:#295b82;color:#d7f5ff;box-shadow:inset 3px 0 #39cbef}
.nav-label{padding:0 12px;color:#8199b5;letter-spacing:.14em;text-transform:uppercase;font-size:10px;font-weight:800;margin:0 0 10px}
.who{margin-top:auto;border:1px solid #294158;background:#122238;padding:14px;border-radius:14px;font-size:12px;line-height:1.5;color:#aec2d7}.who strong{color:#ebf6ff;display:block}
.who form{margin-top:10px}
main{min-width:0;padding:26px clamp(16px,4vw,56px) 60px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;border-bottom:1px solid #24354a;padding-bottom:20px;margin-bottom:22px}
.eyebrow{color:#55cbe8;text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:800}
h1{margin:6px 0 0;font-size:clamp(23px,3vw,30px);letter-spacing:-.03em}
h2{font-size:18px;margin:0 0 4px;letter-spacing:-.01em}h3{font-size:14px;margin:0 0 4px}
.muted{color:#93a9c4;font-size:13px;margin:0;line-height:1.55}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:20px}
.card{border:1px solid #213a53;background:#0e1d30;border-radius:15px;padding:18px}.card .label{color:#9fb4cb;font-size:12px}
.metric{font-size:28px;font-weight:800;margin:10px 0 4px;letter-spacing:-.03em}.metric.word{font-size:18px;letter-spacing:-.01em;color:#d0dfef}
.note{font-size:12px;color:#8ea6c1;line-height:1.5}
.panel{background:#0e1d30;border:1px solid #223850;border-radius:16px;margin-bottom:18px;overflow:hidden}
.panel-body{padding:20px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:20px 20px 12px}
.split{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);gap:18px}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}
th{color:#8aa4c0;font-size:10px;text-transform:uppercase;letter-spacing:.09em;background:#101f32;padding:11px 18px;border-top:1px solid #243a51;border-bottom:1px solid #243a51;white-space:nowrap}
td{padding:13px 18px;color:#bcd0e3;border-bottom:1px solid #1b2f45;vertical-align:top}tr:last-child td{border-bottom:0}
.empty{text-align:center;padding:32px 20px}.empty strong{display:block;margin-bottom:6px}.empty p{font-size:13px;color:#93a9c4;max-width:420px;margin:0 auto;line-height:1.6}
.btn{display:inline-block;background:#1e6eaa;border:1px solid #3694d4;border-radius:9px;color:#e4f6ff;padding:9px 14px;font-weight:700;font-size:13px;text-decoration:none;cursor:pointer}
.btn:hover{background:#2580c2;color:#fff}.btn.quiet{background:transparent;border-color:#3a5674;color:#c4d8ea}.btn.quiet:hover{background:#17283c}.btn.danger{background:#6a2a2e;border-color:#a2484f}
form.stack{display:grid;gap:14px}.field{display:grid;gap:5px}.field label{font-size:13px;font-weight:650;color:#d6e4f2}
.field .help{font-size:12px;color:#8ea6c1;line-height:1.5}
input[type=text],input[type=url],input[type=email],input[type=number],input[type=date],input[type=datetime-local],input[type=password],input[type=search],select,textarea{width:100%;background:#091727;color:#eff7ff;border:1px solid #3a526c;border-radius:9px;padding:9px 11px;font-size:14px}
textarea{min-height:92px;resize:vertical}.field.invalid input,.field.invalid select,.field.invalid textarea{border-color:#ef7f7f}.field-error{color:#ffb4b4;font-size:12px;font-weight:600}
.form-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}
.inline{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0}.inline select{width:auto;padding:6px 8px;font-size:13px}.inline input[type=text]{width:auto}
.searchbar{display:flex;gap:8px;flex-wrap:wrap}.searchbar input{flex:1;min-width:200px}
.banner{border-radius:12px;padding:13px 16px;font-size:13px;line-height:1.55;margin-bottom:18px;border:1px solid #28536c;background:#102338;color:#cfe4f2}.banner strong{display:block;color:#e3f7ff}
.banner.error{border-color:#8a3a40;background:#2c1519;color:#ffd7d7}.banner.error strong{color:#ffe7e7}.banner.warn{border-color:#765230;background:#332819;color:#ffe2ad}.banner.warn strong{color:#ffedcc}.banner.ok{border-color:#2d6a4f;background:#10291f;color:#cdeedd}.banner.ok strong{color:#e2f8ed}
.tag{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:3px 8px;border:1px solid #31506a;background:#142d43;color:#b8d6ec;white-space:nowrap}
.tag.good{background:#123325;border-color:#2d6a4f;color:#a9ebc9}.tag.bad{background:#3a1a1e;border-color:#8a3a40;color:#ffc2c2}.tag.warn{background:#473322;border-color:#765230;color:#ffd693}.tag.unknown{background:#1c2a3b;border-color:#3a526c;color:#b4c5d8}
dl.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 18px;margin:0;font-size:13px}dt{color:#93a9c4}dd{margin:0;overflow-wrap:anywhere;color:#dbe8f4}
.subnav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px}.subnav a{font-size:13px;padding:7px 12px;border:1px solid #2c4560;border-radius:8px;text-decoration:none;color:#bcd0e3}.subnav a:hover{background:#17283c}
details{border-top:1px solid #1b2f45;padding:12px 20px}details summary{cursor:pointer;font-size:13px;font-weight:650;color:#c4d8ea}details form{margin-top:12px}
.capability{padding:12px 0;border-bottom:1px solid #1b2f45;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 14px;font-size:13px}.capability:last-child{border-bottom:0}.capability .detail{grid-column:1/-1;color:#93a9c4;font-size:12px;line-height:1.55}
ul.plain{list-style:none;margin:0;padding:0}ul.plain li{padding:9px 0;border-bottom:1px solid #1b2f45;font-size:13px}ul.plain li:last-child{border-bottom:0}
.login{min-height:100vh;display:grid;place-items:center;padding:20px}.login section{max-width:430px;width:100%;background:#0e1d30;border:1px solid #223850;border-radius:18px;padding:30px}.login .brand{padding:0;margin-bottom:22px}.login .btn{margin-top:18px;width:100%;text-align:center}
code{font-size:12px;background:#091727;border-radius:5px;padding:2px 5px;overflow-wrap:anywhere}
.skip{position:absolute;left:-999px}.skip:focus{left:12px;top:12px;background:#143557;padding:8px 12px;border-radius:8px;z-index:2}
.footer{margin-top:24px;color:#8199b5;font-size:12px}
@media(max-width:1000px){.split{grid-template-columns:1fr}}
td code{white-space:nowrap}
@media(max-width:760px){.app{grid-template-columns:minmax(0,1fr)}.sidebar{min-width:0;padding:14px 16px;gap:12px;border-right:0;border-bottom:1px solid #243449}.sidebar>div{min-width:0}.nav-label{display:none}.nav{display:flex;overflow-x:auto;padding-bottom:4px}.nav a{white-space:nowrap;padding:8px 11px}.who{margin-top:0;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px}.who form{margin:0}dl.facts{grid-template-columns:1fr}dd{margin-bottom:6px}}
`;
