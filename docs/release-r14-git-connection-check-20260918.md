# r14 Git delivery verification — 2026-09-18

The owner reported that the existing Vercel MenuGO project was connected to this repository. This documentation-only commit triggers the Git integration without changing application behavior, credentials, data, or prices.

Approved application revision: `1febac655cafd5caae5950837233254a855c840d`.
Expected public release: `menugo-camera-entry-20260918-r14`.
Existing Vercel project: `menugo`.
Expected production branch: `main`.

Before declaring the release live, verify the Vercel deployment reaches READY on the existing project, the production domain serves the r14 release manifest, and `/siparis` renders the camera entry with photo and link fallbacks. A Git push or successful GitHub Actions run alone is not proof of a production deployment.

Verification should not create a restaurant visit, order, payment, customer account, SMS, or courier request. Physical-device camera behavior requires a separate device test.
