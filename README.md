# AI Listings — Packages

Static pricing + agreement flow for AI Listings, deployed at **packages.ailistings.co.uk**.

This is an MVP (Phase 1): no backend, no Stripe API. Three Stripe **Payment Links** collect
the setup fee + first month and create the monthly subscription automatically.

## Flow

```
/ (index.html)            Pricing page — slider selects Foundation / Growth / Accelerate
   ↓  "Continue to Agreement & Payment"
/agreement?plan=<slug>    Review programme + key terms, tick both acceptance boxes
   ↓  "Proceed To Secure Payment"  (records acceptance, then redirects)
Stripe Payment Link       Collects payment + creates subscription
   ↓  (success URL set in the Stripe dashboard)
Thank-you / onboarding    (configured per Payment Link in Stripe)
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | Pricing page (the slider selector). Home route `/`. |
| `agreement.html` | Agreement & confirmation page. Route `/agreement`. |
| `favicon.png` | Browser tab icon (brand mark). |
| `logo-mark.png` | Brand icon used in the page header. |
| `logo-full.png` | Full stacked logo (not used by default; available if wanted). |
| `vercel.json` | Vercel config — clean URLs + basic security headers. |

## Stripe Payment Links

Configured in `agreement.html` (the `plans` object):

| Plan | Setup + First Month | Link |
|------|---------------------|------|
| Foundation | £399 + £199 = £598 + VAT | https://buy.stripe.com/28EeVc75sey98JY7Kx5AQ0G |
| Growth | £599 + £399 = £998 + VAT | https://buy.stripe.com/00w28q9dA89L5xM9SF5AQ0F |
| Accelerate | £799 + £699 = £1,498 + VAT | https://buy.stripe.com/3cI8wOcpM75H5xM4yl5AQ0E |

> **Stripe checklist (do in the Stripe dashboard, not in code):**
> 1. Each Payment Link must include **two line items**: the one-time setup fee **and** the
>    recurring monthly price (so the subscription is created after payment). Double-check the
>    **Foundation** link — its label currently reads "Setup Fee" only.
> 2. Set each link's **success URL** to your thank-you / onboarding page.
> 3. Enable "Collect customer address / tax (VAT)" as required.

## Acceptance evidence

Before redirecting to Stripe, `agreement.html` stores an acceptance record in `localStorage`
(`aiListings_agreement_<slug>`): both checkbox states, plan, fees, terms version, ISO timestamp
and user agent. In Phase 2 this should be persisted server-side (with IP + server timestamp).

## Deploy (Vercel)

1. Push this folder to a **private** Git repo.
2. In Vercel: **New Project → import the repo**. Framework preset: **Other** (static).
   No build command, no output directory — Vercel serves the files as-is.
3. Add the domain **packages.ailistings.co.uk** under Project → Settings → Domains, and point
   a CNAME for `packages` at `cname.vercel-dns.com` in your DNS.

## Local preview

```bash
python -m http.server 8753
# open http://localhost:8753/
```

## Phase 2 (later)

Webhook → CRM → Slack channel creation → onboarding automation; dynamic agreement PDF +
e-signature; server-stored acceptance. None of this is required for launch.

---

**Note:** the full Terms & Conditions in `agreement.html` are a working draft and should be
reviewed/finalised by a legal advisor before go-live.
