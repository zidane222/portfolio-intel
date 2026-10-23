# Incident response plan

**Severity:** High = user data or credentials exposed; Medium = service down or attack in progress; Low = suspicious activity.

1. **Detect:** security scan alert, SOC monitor summary, GitHub or vendor notice, user report.
2. **Contain:** rotate the affected keys, revoke sessions in Supabase, disable the affected route or Worker, block abusive origins.
3. **Investigate:** Cloudflare logs, Supabase auth logs, GitHub audit log. Write down the timeline.
4. **Recover:** deploy the fix through a PR, restore data from backups if needed, confirm with qa.
5. **Notify:** tell affected users promptly. Under the GLBA Safeguards Rule, notify the FTC within 30 days of discovering an event affecting 500 or more people. Check state breach laws (Texas: notify affected Texans within 60 days, and the Attorney General within 30 days if 250 or more Texans).
6. **Learn:** within 5 days, write a short post-incident note and add any new risk to RISK_REGISTER.md.

Test this plan with a tabletop exercise once a year.
