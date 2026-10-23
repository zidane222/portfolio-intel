# Information security policy

Owner: Hisham Abbasi (security owner and qualified individual). Reviewed quarterly. Approved: 2026-10-23.

1. **Scope:** the Portfolio Intel app, its Workers, data jobs, and every account used to run them.
2. **Principles:** least privilege, encryption by default, no secrets in code, every change reviewed.
3. **User data** is encrypted on the device before it leaves it. Servers store only ciphertext.
4. **Accounts** for GitHub, Cloudflare, Supabase, Google Cloud, Render, Groq and Plaid use MFA and are used only by the owner.
5. **Development** follows the team workflow in CLAUDE.md: plan, build, test, security review, owner approval.
6. **Exceptions** are written in RISK_REGISTER.md with a reason and an end date.
7. Related policies: access control, change management, incident response, data retention and privacy, vendor management, business continuity.
