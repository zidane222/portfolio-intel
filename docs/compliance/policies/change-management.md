# Change management policy

- Every change reaches `main` through a pull request. The owner approves and merges.
- Each PR has: a plan (architect), passing tests (qa), a security review (appsec), and an evidence row (compliance).
- Automated checks run on every PR: tests, secret scan, dependency scan, CodeQL.
- Emergency fixes may be merged first and reviewed within 2 business days, noted in EVIDENCE.md.
- Database schema changes ship as SQL files in `supabase/` and are applied by the owner.
- Rollback: revert the PR; Workers redeploy automatically from `main`.
