# Admin pages — LOCAL USE ONLY

These files are INTENTIONALLY excluded from Cloudflare Pages ASSETS deployment.

Access in production: Only via Worker-guarded endpoint with ADMIN_SECRET_TOKEN bearer.
If you need to access admin UI in prod:
  curl -H "Authorization: Bearer <ADMIN_SECRET_TOKEN>" https://mirpdf.com/admin/revenue-dashboard.html

Do NOT move these files to public/admin/ — that would expose them to unauthenticated access.
Cloudflare Zero Trust Access is the recommended alternative for team admin access.
