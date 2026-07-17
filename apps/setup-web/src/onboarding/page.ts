export function renderProductionOnboardingPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AgentPay mainnet setup</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090b10;color:#f5f7fb}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#1a2440 0,#090b10 48%)}
    main{width:min(720px,100%);background:#10141d;border:1px solid #293249;border-radius:20px;padding:28px;box-shadow:0 24px 80px #0008}
    .eyebrow{color:#7ee7c4;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-size:clamp(28px,5vw,44px);margin:10px 0}p{color:#aeb8cc;line-height:1.55}
    dl{display:grid;grid-template-columns:160px 1fr;gap:10px 18px;margin:24px 0;padding:18px;background:#0b0e14;border-radius:14px}dt{color:#7f8aa3}dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:13px}
    button{width:100%;border:0;border-radius:12px;padding:15px 18px;background:#72e5bd;color:#07110d;font-weight:800;font-size:16px;cursor:pointer}button:disabled{opacity:.45;cursor:wait}
    #status{min-height:24px;margin-top:16px;color:#d8dfed}.safe{display:flex;gap:9px;align-items:center;color:#9fb0c9;font-size:13px}.dot{width:8px;height:8px;background:#72e5bd;border-radius:50%}
    [hidden]{display:none!important}@media(max-width:560px){main{padding:20px}dl{grid-template-columns:1fr}dt{margin-top:8px}}
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">X Layer mainnet · chain 196</div>
    <h1>Create your AgentPay wallet</h1>
    <p>The owner wallet signs one setup authorization. No payment is sent and AgentPay sponsors deployment gas.</p>
    <div class="safe"><span class="dot"></span><span>Canonical USDT0 only · no route targets · no wallet private key requested</span></div>
    <dl id="details" hidden>
      <dt>Owner</dt><dd id="owner">—</dd>
      <dt>Chain</dt><dd id="chain">196</dd>
      <dt>Factory</dt><dd id="factory">—</dd>
      <dt>Predicted account</dt><dd id="account">—</dd>
      <dt>Executor</dt><dd id="executor">—</dd>
      <dt>Token</dt><dd id="token">—</dd>
      <dt>Routes</dt><dd>None</dd>
      <dt>Deadline</dt><dd id="deadline">—</dd>
      <dt>Manifest</dt><dd id="manifest">—</dd>
    </dl>
    <button id="action" type="button">Connect owner wallet</button>
    <div id="status" role="status" aria-live="polite"></div>
  </main>
  <script nonce="${nonce}">
  (()=>{
    const $=(id)=>document.getElementById(id);let capability=null,csrfToken=null,typedData=null,owner=null,pollTimer=null;
    const setStatus=(text)=>{$("status").textContent=text};
    const provider=()=>window.okxwallet||window.ethereum;
    const api=async(path,options={})=>{const response=await fetch(path,{credentials:"same-origin",cache:"no-store",...options});const body=await response.json();if(!response.ok)throw new Error(body.error||"SETUP_UNAVAILABLE");return body};
    const show=(data)=>{const m=data.message;typedData=data;owner=m.owner;$("details").hidden=false;$("owner").textContent=m.owner;$("factory").textContent=m.factory;$("account").textContent=m.predictedAccount;$("executor").textContent=m.executor;$("token").textContent=m.token;$("deadline").textContent=new Date(Number(m.deadline)*1000).toISOString();$("manifest").textContent=m.manifestSha256};
    const poll=async()=>{try{const state=await api("/api/setup/status",{headers:{"x-agentpay-setup-capability":capability}});setStatus(state.status==="SETUP_COMPLETED"?"Setup completed. Return to chat to continue.":"Deployment status: "+state.status);if(state.status==="SETUP_COMPLETED"){clearInterval(pollTimer);$("action").hidden=true}}catch{setStatus("Status is temporarily unavailable. Keep this page open.")}};
    $("action").addEventListener("click",async()=>{const wallet=provider();if(!wallet){setStatus("Install or enable an EVM wallet first.");return}$("action").disabled=true;try{const accounts=await wallet.request({method:"eth_requestAccounts"});const chainId=await wallet.request({method:"eth_chainId"});if(chainId!=="0xc4")throw new Error("Switch the owner wallet to X Layer mainnet (chain 196).");if(!accounts?.[0])throw new Error("No owner account was returned.");
      if(!typedData){const challenge=await api("/api/setup/challenge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ownerAddress:accounts[0]})});capability=challenge.capability;csrfToken=challenge.csrfToken;show(challenge.typedData);$("action").textContent="Review and sign setup";setStatus("Check every field, then sign with the displayed owner wallet.");return}
      if(accounts[0].toLowerCase()!==owner.toLowerCase())throw new Error("Connected wallet does not match the setup owner.");const payload={...typedData,types:{EIP712Domain:[{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}],...typedData.types}};const signature=await wallet.request({method:"eth_signTypedData_v4",params:[owner,JSON.stringify(payload)]});await api("/api/setup/authorize",{method:"POST",headers:{"content-type":"application/json","x-agentpay-setup-capability":capability,"x-agentpay-csrf-token":csrfToken},body:JSON.stringify({signature})});$("action").textContent="Deployment submitted";setStatus("Authorization accepted. Waiting for sponsored deployment…");pollTimer=setInterval(poll,2000);await poll()
    }catch(error){setStatus(error instanceof Error?error.message:"Setup is unavailable.")}finally{$("action").disabled=false}});
  })();
  </script>
</body>
</html>`;
}
