
/**
 * Email sending via Resend.
 * Env:
 *   RESEND_API_KEY
 *   EMAIL_FROM (e.g. "MirPDF <no-reply@mirpdf.com>")
 *   APP_ORIGIN (e.g. "https://mirpdf.com")
 */
export async function sendEmail(env, { to, subject, html }) {
  const key = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (!key || !from) return { ok: false, skipped: true, reason: "EMAIL_NOT_CONFIGURED" };

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return { ok: false, reason: `RESEND_${resp.status}`, detail: txt.slice(0, 200) };
  }
  return { ok: true };
}

export function verifyEmailHtml(origin, token) {
  const url = `${origin}/account/verify.html#token=${encodeURIComponent(token)}`;
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6">
      <h2>Email Doğrulama</h2>
      <p>Hesabını doğrulamak için aşağıdaki butona tıkla:</p>
      <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none">Email'i Doğrula</a></p>
      <p>Çalışmazsa bu linki kopyala:</p>
      <p>${url}</p>
    </div>
  `;
}

export function resetPasswordHtml(origin, token) {
  const url = `${origin}/account/reset.html#token=${encodeURIComponent(token)}`;
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6">
      <h2>Şifre Sıfırlama</h2>
      <p>Şifreni sıfırlamak için aşağıdaki butona tıkla:</p>
      <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none">Şifreyi Sıfırla</a></p>
      <p>Çalışmazsa bu linki kopyala:</p>
      <p>${url}</p>
    </div>
  `;
}
