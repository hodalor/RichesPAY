# Testing Guide

## Simulator Mobile Money Numbers

Test-mode mobile money traffic uses the simulator provider. The simulator behavior is determined by the phone number ending:

| Ending | Submit behavior | Follow-up behavior |
| --- | --- | --- |
| `0001` | Accepted immediately | Callback succeeds after 5 seconds |
| `0002` | Fails immediately | `insufficient_funds` |
| `0003` | Accepted and stays pending | No callback; `getStatus()` succeeds later |
| `0004` | Fails immediately | Provider status is `customer_declined` |
| `0005` | Times out | Outcome is unknown on submit, then `getStatus()` succeeds |
| Any other suffix | Accepted immediately | Callback succeeds after 3 seconds |
