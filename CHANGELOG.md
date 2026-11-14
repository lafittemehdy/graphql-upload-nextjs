# Changelog

## 3.1.4 - 2026-11-14

- Restrict `setValueAtPath` to own containers so inherited objects and arrays are never mutated as a side effect.
- Preserve existing own-property path behavior and express forbidden prototype keys directly for static verification.
- Add object and array inheritance regression tests.

## 3.1.3 - 2026-11-14

- Document the current Apollo Server transitive dependency advisory and application-root mitigation.

- Update dependencies and example applications to current compatible stable releases.
- Include contribution guidelines, the Contributor Covenant, and a private security reporting policy in the repository and npm package.
- Patch affected transitive development dependencies and verify production and development dependency audits.
- Create example upload files with private permissions and disable download caching.
- Keep the example landing page readable on narrow screens.

