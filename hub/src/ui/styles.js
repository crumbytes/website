// CrumByte workspace styling. Served as one
// same-origin file so the Content-Security-Policy can forbid inline styles.
export const HUB_CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#eaf2ff;background:#08111f;font-synthesis:none;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#08111f}
a{color:#8ad9ee}a:hover{color:#c4f1fb}
button,input,select,textarea{font:inherit}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,.table-wrap:focus-visible,summary:focus-visible{outline:3px solid #60d9ec;outline-offset:2px}
.app{display:grid;grid-template-columns:258px minmax(0,1fr);min-height:100vh}
.sidebar{border-right:1px solid #243449;background:#0c1728;padding:20px 16px;display:flex;flex-direction:column;gap:16px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;gap:12px;align-items:center;padding:0 12px;color:inherit;text-decoration:none}
.brandmark{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;background:linear-gradient(145deg,#27cee6,#2362d8);font-size:22px;font-weight:900;color:#fff}
.brand strong{display:block;font-size:17px}.brand small{color:#94a9c5;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.nav{display:grid;gap:2px}.nav a{display:block;color:#a8bbd1;text-decoration:none;border:1px solid transparent;border-radius:9px;padding:7px 12px;font-size:14px}
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
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0}.filters input[type=search]{flex:1 1 200px;width:auto}.filters select{width:auto;flex:0 1 auto;max-width:100%}.filters label{font-size:13px;display:inline-flex;gap:6px;align-items:center}.filters input[type=date]{width:auto}
td ul.plain li{padding:3px 0;border:0;font-size:12px}
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
@media(max-width:760px){.app{grid-template-columns:minmax(0,1fr)}.sidebar{min-width:0;padding:14px 16px;gap:12px;border-right:0;border-bottom:1px solid #243449;position:static;height:auto;overflow:visible}.sidebar>div{min-width:0}.nav-label{display:none}.nav{display:flex;overflow-x:auto;padding-bottom:4px}.nav a{white-space:nowrap;padding:8px 11px}.who{margin-top:0;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px}.who form{margin:0}dl.facts{grid-template-columns:1fr}dd{margin-bottom:6px}}

/* Workspace hierarchy and interaction states; no external assets or scripts. */
:root{--accent:#72b4ff;--surface:#101e33;--border:#293e59;scroll-behavior:auto}
body{background:#091324;color:#e8eff9}
.app{grid-template-columns:244px minmax(0,1fr)}
.sidebar{background:#0a1425;border-color:#223550;padding:24px 18px;gap:20px}
.brand{padding:0 8px}.brandmark{background:linear-gradient(145deg,#3b93f7,#1e54be);box-shadow:0 5px 18px #102e59;border:1px solid #5ca8ff;border-radius:11px}
.brand strong{letter-spacing:-.025em;font-size:20px}.brand small{font-size:10px;letter-spacing:.13em}
.nav-label{font-size:10px;color:#a6b9d0;letter-spacing:.1em;margin-bottom:14px}
.nav{gap:4px}.nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;font-size:13px;min-height:34px}
.nav-symbol{display:inline-flex;align-items:center;justify-content:center;width:19px;flex:0 0 19px;color:#93afcf;font-size:19px;line-height:1}
.nav a[aria-current=page]{background:#153357;border-color:#315580;color:#fff;box-shadow:inset 3px 0 #72b4ff}.nav a[aria-current=page] .nav-symbol{color:#9acaff}
.who{background:#101f34;border-color:#293f5b;border-radius:12px}.who .btn{font-size:12px}
main{padding:28px clamp(20px,3vw,46px) 48px;max-width:1900px;width:100%;margin:0 auto}
main:focus{outline:none}.topbar{margin-bottom:28px;padding-bottom:24px;border-color:#243852}
.workspace-path{color:#a6bad3;font-size:12px;margin-bottom:10px}.workspace-path span{padding:0 8px;color:#718da9}
.environment-note{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#ffdea5;background:#362b1e;border:1px solid #745a33;padding:3px 7px;border-radius:5px;margin:0 0 5px}
h1{font-size:clamp(25px,3vw,32px);font-weight:750;letter-spacing:-.035em}h2{font-size:17px}
.workspace-intro{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}.workspace-intro .eyebrow{font-size:10px;color:#8ac0ff;margin:0 0 8px}.workspace-intro h2{font-size:23px;letter-spacing:-.03em;margin-bottom:7px}
.cards{gap:14px}.primary-metrics{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px}.coverage-metrics{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:28px}
.card{background:linear-gradient(135deg,#12243d,#101d31);border-color:#2b425f;border-radius:12px;padding:19px;min-width:0}
.metric-card{display:block;text-decoration:none;color:inherit}.metric-card:hover{background:#172d49;border-color:#6c9dd2;color:#fff}.metric-card .label{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:#c3d3e6}.metric-card .label .card-arrow{display:block;flex:0 0 8px;width:8px;height:8px;border-top:1px solid #93b8e0;border-right:1px solid #93b8e0;position:relative;margin:4px 2px 0 0}.card-arrow:after{content:"";position:absolute;width:10px;height:1px;background:#93b8e0;transform:rotate(-45deg);top:3px;left:-2px}
.metric{font-size:34px;line-height:1.2;letter-spacing:-.04em;margin:13px 0 9px;color:#f4f8ff}.metric.word{font-size:19px;line-height:1.4;margin-bottom:10px}.coverage-metrics .card{background:#0e1c30}.coverage-metrics .note{font-size:11px;color:#a0b4ce}
.panel{background:#0f1e32;border-color:#293e59;border-radius:13px;box-shadow:0 3px 12px #050b161a}.panel-head{padding:21px 22px 15px}.panel-head>a{font-size:12px;color:#99caff;white-space:nowrap}.panel-body{padding:22px}
.section-kicker{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#a3bad4;margin:0 0 8px}.approval-note{margin:0;padding:0 22px 16px;color:#b8c9df;font-size:12px;line-height:1.8}
.feed{list-style:none;margin:0;padding:0 22px 10px}.feed li{display:flex;gap:12px;padding:16px 0;border-top:1px solid #263950;min-width:0}.feed li>div{min-width:0;overflow-wrap:anywhere}.feed p{margin:0 0 5px;font-size:13px;line-height:1.6;color:#d8e4f4}.feed a{font-size:13px;font-weight:600;line-height:1.6}.feed .note{margin-top:5px;font-size:11px;color:#a7bad2}.feed-marker{width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:#75b4ff;margin-top:7px;box-shadow:0 0 0 4px #192e49}.feed-marker.attention{background:#ffc47a;box-shadow:0 0 0 4px #352b20}
.empty{padding:35px 22px}.empty:before{content:'—';display:block;font-size:23px;color:#94b8e2;margin:0 auto 12px;width:38px;height:38px;border:1px solid #385374;border-radius:10px;line-height:32px;background:#14263d}.empty strong{font-size:14px}.empty p{font-size:12px;color:#a6bad2}
.btn{background:#2368b8;border-color:#5499e7;color:#fff;border-radius:8px;min-height:38px}.btn:hover{background:#2c7ad1}.btn.quiet{color:#d4e6fb;border-color:#48698e}.btn.danger{background:#6a2a2e;border-color:#bc7379}
td{line-height:1.6;border-color:#263a52}th{background:#13243b;color:#b0c7e2;font-size:10px;letter-spacing:.07em}tbody tr:hover{background:#14263c}.table-wrap{scrollbar-color:#526f92 #0c1829}
.stack{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}.stack>.field:has(textarea),.stack>div:has(>button),.stack>.muted,.stack>.banner{grid-column:1/-1}.field label{line-height:1.5}.field .help{line-height:1.6}.field input,.field select{min-height:42px}textarea{min-height:110px}
.subnav{padding:10px;background:#0d1b2e;border:1px solid #293f5a;border-radius:11px;gap:5px}.subnav a{border-color:transparent;font-size:12px}.subnav a:hover{border-color:#50759c}
details summary{line-height:1.6;min-height:24px}details[open]{background:#112238}details[open]>summary{margin-bottom:8px;color:#b2d6ff}.tag{max-width:100%;white-space:normal;line-height:1.5}.footer{padding-top:16px;border-top:1px solid #273a51;color:#9cb1cc}
@media(min-width:1550px){.split{grid-template-columns:minmax(0,1.45fr) minmax(0,1fr)}}
@media(max-width:1200px){.primary-metrics,.coverage-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.app{grid-template-columns:220px minmax(0,1fr)}.sidebar{padding:24px 14px}.split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:760px){.app{grid-template-columns:minmax(0,1fr)}.sidebar{padding:16px;gap:14px}.brand{padding:0}.brand strong{font-size:18px}.brandmark{width:34px;height:34px}.nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;overflow:visible;padding:0}.nav a{font-size:11px;white-space:normal;padding:7px;gap:5px;min-height:40px;line-height:1.4}.nav-symbol{display:none}.who{padding:9px 12px;font-size:11px}.who strong{font-size:12px}.who .btn{min-height:34px;padding:7px 10px}main{padding:22px 16px 36px}.topbar{margin-bottom:20px;padding-bottom:18px}.workspace-path{font-size:11px}.workspace-intro{align-items:flex-start;flex-direction:column;gap:14px}.workspace-intro h2{font-size:21px}.cards{gap:10px}.card{padding:15px}.metric{font-size:29px}.metric.word{font-size:17px}.primary-metrics .note{font-size:11px}.stack{grid-template-columns:minmax(0,1fr)}.panel-head,.panel-body{padding:17px}.feed{padding:0 17px 5px}.approval-note{padding:0 17px 12px}.filters{width:100%}.filters select{flex:1 1 130px}.filters .btn{flex:1 1 90px}.subnav{gap:3px;padding:6px}.subnav a{padding:7px 9px}details{padding:12px 17px}}
@media(prefers-reduced-motion:no-preference){.btn,.nav a,.metric-card{transition:background .15s,border-color .15s}}

.portal-panel{padding:16px}.portal-panel h2{margin:0 0 10px}.portal-panel h3{margin:12px 0 6px}.portal-panel>p{margin:8px 0 12px}.portal-panel article{padding:10px 0;border-top:1px solid #273b54}.portal-panel details{margin-top:12px}.portal-panel label{display:block}.portal-panel .table-wrap{margin-top:10px}
`;
