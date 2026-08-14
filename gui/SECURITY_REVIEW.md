# GUI dependency security review

## eslint-plugin-react-refresh 0.5.3

Reviewed for the GUI dependency update. The package is an ESLint plugin used
only during development/build checks; it is not bundled or executed in the
production runtime. The version is sourced through the project lockfile and no
known security issue was identified at review time.

Review date: 2026-02-01

## nanoid 3.3.18

Reviewed for the GUI dependency override addressing the nanoid advisory. The
pinned version is used as a transitive dependency and no additional production
runtime exposure was identified during review.

Review identifier: GUI-SECURITY-NANOID-3.3.18
Review date: 2026-02-01
