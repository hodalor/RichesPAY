# PCI Scope Notes

RichesPay keeps card-data scope as small as possible by never sending card numbers or CVV through `apps/api`.

Card entry happens only on the acquirer's hosted page or hosted-fields iframe returned by the `CardAcquirer` adapter. RichesPay stores and displays only the masked card result returned by the acquirer, such as brand, last4, and expiry.

3-D Secure is also handled on the acquirer side. Final payment results reach RichesPay through provider callbacks and status checks, which means the platform can reconcile card collections and refunds without collecting sensitive cardholder data itself.

The local simulator follows the same integration shape for testing: the browser form posts only masked card metadata back to the callback endpoint, never full PAN or CVV.
