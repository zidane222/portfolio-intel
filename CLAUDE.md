# Portfolio Intel: how the dev team works

Portfolio Intel is built by a team of role agents in `.claude/agents/`. Claude runs them inside
sessions with the owner (Hisham). Groq only powers AI features inside the running app; it never
writes code. No agent merges to `main`: every change goes through a pull request the owner approves.

## Flow for any change
1. **architect** writes a short plan: scope, files, contracts, risks. Checks it against `docs/ARCHITECTURE.md`.
2. **frontend**, **server** and **microservices** build their parts, in parallel when independent.
3. **qa** runs the worker tests (as in `.github/workflows/security.yml`, with the Fernet test token), the browser journeys, and adds tests for the change.
4. **appsec** reviews the diff against OWASP ASVS and `docs/compliance/CONTROLS.md`.
5. **compliance** records evidence (PR, tests, scans) and updates controls if anything changed.
6. **architect** gives the final review and opens the PR. The owner merges by saying "yes".
7. **ux-discovery** runs on request or monthly, producing research, never code.

## House rules
- Secrets never go in code, commits or logs. Workers use the Cloudflare Secrets Store, GitHub Actions use repository secrets or Workload Identity Federation.
- User portfolio data is encrypted on the device (AES-GCM) before sync. Never add a path that sends it to a server in plain text.
- No em dashes in user-facing text. Plain, direct language.
- Render is the fallback backend and stays on.
- Nothing in the app gives personalized investment advice or places trades. Strategy output is simulated and labeled so.
