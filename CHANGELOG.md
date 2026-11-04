# Changelog

## 0.1.0 — initial release

- Merged .NET configuration viewer with tree and flat views, search, and per-value provenance with override chains.
- Simulated default `WebApplication.CreateBuilder` merge order: JSON layers, user secrets, environment variables, command-line args.
- Project, launch profile and environment selection.
- Masking of sensitive values with per-value reveal.
- Copy value, key path or environment variable name; export as JSON or `KEY=value`.
- Auto-refresh on configuration file changes.
