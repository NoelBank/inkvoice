---
layout: home

hero:
  name: Inkvoice
  text: Self-hosted invoicing
  tagline: A lightweight, open-source invoicing dashboard. Create, manage, and share professional invoices — all from a single Docker container.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/pigontech/inkvoice

features:
  - title: Lightweight
    details: Runs on 50-100MB RAM. Built with Hono + React on Bun — no heavy frameworks, no wasted resources.
  - title: Single Container
    details: One Docker image serves both the API and frontend. No nginx, no reverse proxy — just deploy and go.
  - title: Full Invoice Lifecycle
    details: Draft, send, track, and get paid. Supports quotes, recurring invoices, credit notes, and partial payments.
  - title: PDF Generation
    details: Generate professional PDFs from customizable Mustache templates. Share invoices via public links.
  - title: Online Payments
    details: Accept card payments via Stripe or PayPal. Customers pay directly from their invoice link.
  - title: E-Rechnung (German e-invoicing)
    details: Emit EN 16931-compliant ZUGFeRD 2.2 hybrid PDFs, XRechnung and PEPPOL BIS, and receive incoming e-invoices. An opt-in module, off by default.
  - title: France E-Invoicing (Factur-X)
    details: Emit Factur-X with French buyer identifiers (SIREN/SIRET) and the franchise-en-base exemption. On Inkvoice Cloud, deliver through Qonto, a registered PDP/PA.
  - title: Self-Hosted Friendly
    details: Deploy on Dokploy, Coolify, or any Docker host. Your data stays on your server.
---
