# Implementation Plan: Payments (mock)

## Summary

Minimal checkout: credit-card form → order record. No refunds, no saved cards,
no multi-currency. Depends on Authentication (feature 1) for the logged-in
user check.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict)
**Primary Dependencies**: Node/Electron. Stripe SDK listed only to demonstrate
the shape of a plan — the mock does not actually install it.

## Project Structure

```
src/mock/
└── c2-f-002.ts   # this feature's placeholder module
```
