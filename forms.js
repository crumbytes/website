// Shared contact/support submission. Credentials remain in the server environment.
(() => {
  const forms = [
    { id: 'contact-form', status: 'form-status', button: 'send', kind: 'contact',
      success: 'Thank you! Your request has been submitted. We’ll be in touch soon.' },
    { id: 'remote-request', status: 'request-status', button: 'send-request', kind: 'support',
      success: 'Thank you! Your remote support request has been submitted. Our team will contact you to discuss the next steps.' }
  ];
  for (const config of forms) {
    const form = document.getElementById(config.id);
    if (!form) continue;
    const status = document.getElementById(config.status);
    const button = document.getElementById(config.button);
    let lastPayload = '', requestId = '';
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (button.disabled) return;
      const data = Object.fromEntries(new FormData(form).entries());
      data.kind = config.kind;
      const fingerprint = JSON.stringify(data);
      if (fingerprint !== lastPayload) {
        requestId = crypto.randomUUID();
        lastPayload = fingerprint;
      }
      data.requestId = requestId;
      button.disabled = true;
      form.setAttribute('aria-busy', 'true');
      status.textContent = 'Submitting your request…';
      try {
        const response = await fetch('/api/contact', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(data), signal: AbortSignal.timeout(25000)
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) throw new Error(result.error || 'Unable to submit your request.');
        status.textContent = config.success;
        form.reset();
        lastPayload = ''; requestId = '';
      } catch {
        status.textContent = 'Your request could not be submitted. Please try again, email info@crumbyte.com, or call 808-285-7724.';
      } finally {
        button.disabled = false;
        form.removeAttribute('aria-busy');
      }
    });
  }
})();
