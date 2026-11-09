## Summary

<!-- What does this PR change and why? -->

## Behavior / compatibility

- [ ] No rule semantics or database schema change
- [ ] Rule semantics changed and documented in `docs/DESIGN.md`
- [ ] Database migration considered
- [ ] UI screenshots attached (if applicable)

## Test plan

```bash
npm run typecheck
npm test
# npm run test:e2e  (UI changes)
# docker compose build  (container changes)
```

## Checklist

- [ ] Tests added/updated for behavior changes
- [ ] No real webhook, proxy credential, `data/`, `.env` or generated artifacts committed
- [ ] Public API/README/docs updated when needed
- [ ] I agree to license this contribution under the MIT License
