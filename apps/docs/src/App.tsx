import * as React from "react";
import { NavLink, Navigate, Route, Routes, useParams } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";
import { RedocStandalone } from "redoc";

import { ERROR_CATALOG, type ErrorCode } from "@richespay/shared";
import { Button, Tabs } from "@richespay/ui";

import changelogMarkdown from "../../../docs/CHANGELOG.md?raw";

type LanguageKey = "curl" | "node" | "php" | "python";

interface ExampleDefinition {
  description: string;
  snippets: Record<LanguageKey, string>;
  title: string;
}

interface GuideSection {
  bullets?: string[];
  example?: ExampleDefinition;
  paragraphs: string[];
  title: string;
}

interface GuideDefinition {
  sections: GuideSection[];
  slug: string;
  summary: string;
  title: string;
}

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? "https://api.richespay.com";
const testSecretKey = "rp_test_sk_...";

const homeCurlExample = [
  "curl https://api.richespay.com/v1/collections \\",
  '  -H "Authorization: Bearer rp_test_sk_..." \\',
  '  -H "Idempotency-Key: order-1001" \\',
  `  -d '{"amount":5000,"currency":"ZMW","phone":"+260970000001","reference":"ORDER-1001"}'`
].join("\n");

const guides: GuideDefinition[] = [
  {
    slug: "quick-start",
    summary: "Create a test collection, receive a webhook, and keep the request shape minimal.",
    title: "Quick start",
    sections: [
      {
        title: "Start in 3 steps",
        paragraphs: [
          "1. Create a test secret key in the dashboard.",
          "2. Create a collection with an amount in minor units.",
          "3. Receive the signed webhook and trust the final status there."
        ],
        example: {
          title: "Create your first test collection",
          description: "Phone implies mobile money, so the request stays short.",
          snippets: {
            curl: homeCurlExample,
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");

              const collection = await richespay.collections.create({
                amount: 5000,
                currency: "ZMW",
                phone: "+260970000001",
                reference: "ORDER-1001"
              }, {
                idempotencyKey: "order-1001"
              });

              console.log(collection);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "amount" => 5000,
                "currency" => "ZMW",
                "phone" => "+260970000001",
                "reference" => "ORDER-1001"
              ]);

              $ch = curl_init("${apiOrigin}/v1/collections");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type: application/json",
                  "Idempotency-Key: order-1001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "amount": 5000,
                  "currency": "ZMW",
                  "phone": "+260970000001",
                  "reference": "ORDER-1001",
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/collections",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "order-1001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "authentication-and-keys",
    summary: "Use secret keys for server-to-server API calls and public keys only for hosted checkout session creation.",
    title: "Authentication and keys",
    sections: [
      {
        title: "Use the right key",
        paragraphs: [
          "Secret keys start with rp_test_sk_ or rp_live_sk_ and authenticate the public API.",
          "Public keys start with rp_test_pk_ or rp_live_pk_ and are only for hosted checkout session creation."
        ],
        bullets: [
          "Send every secret key in Authorization: Bearer <key>.",
          "Keep keys server-side.",
          "Use separate test and live credentials."
        ],
        example: {
          title: "Read your balance",
          description: "A small read request is the quickest way to prove the key is working.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/balance" \\
                -H "Authorization: Bearer ${testSecretKey}"
            `),
            node: trimCode(`
              const balances = await fetch("${apiOrigin}/v1/balance", {
                headers: {
                  Authorization: "Bearer ${testSecretKey}"
                }
              }).then((response) => response.json());

              console.log(balances);
            `),
            php: trimCode(`
              <?php

              $ch = curl_init("${apiOrigin}/v1/balance");
              curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              from urllib import request

              req = request.Request(
                  "${apiOrigin}/v1/balance",
                  headers={"Authorization": "Bearer ${testSecretKey}"},
                  method="GET",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "test-mode-and-magic-numbers",
    summary: "Test keys always stay on the simulator, with deterministic phone and card outcomes.",
    title: "Test mode and magic numbers",
    sections: [
      {
        title: "Use simulator destinations",
        paragraphs: [
          "Phone numbers ending in 0001 succeed, 0002 fail immediately, and 0003 stay pending until later resolution.",
          "Card numbers 4000000000000001, 4000000000000002, and 4000000000000003 cover success, decline, and 3-D Secure."
        ],
        example: {
          title: "Trigger a successful test collection",
          description: "The network is optional when the prefix makes the wallet obvious.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/collections" \\
                -H "Authorization: Bearer ${testSecretKey}" \\
                -H "Content-Type: application/json" \\
                -H "Idempotency-Key: collection-test-0001" \\
                -d '{"amount":5000,"currency":"GHS","phone":"+233241230001","reference":"SIM-0001"}'
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const collection = await richespay.collections.create({
                amount: 5000,
                currency: "GHS",
                phone: "+233241230001",
                reference: "SIM-0001"
              }, {
                idempotencyKey: "collection-test-0001"
              });

              console.log(collection.status);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "amount" => 5000,
                "currency" => "GHS",
                "phone" => "+233241230001",
                "reference" => "SIM-0001"
              ]);

              $ch = curl_init("${apiOrigin}/v1/collections");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type: application/json",
                  "Idempotency-Key: collection-test-0001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "amount": 5000,
                  "currency": "GHS",
                  "phone": "+233241230001",
                  "reference": "SIM-0001",
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/collections",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "collection-test-0001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "collections",
    summary: "Collections stay small: amount in minor units, currency, phone or card path, and your merchant reference.",
    title: "Collections",
    sections: [
      {
        title: "Create and retrieve",
        paragraphs: [
          "For mobile money, a phone number is enough to infer the default method.",
          "Keep your own reference stable so webhooks and dashboard search line up with your order record."
        ],
        example: {
          title: "List collections",
          description: "Cursor pagination uses limit and starting_after everywhere.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/collections?limit=20&status=successful" \\
                -H "Authorization: Bearer ${testSecretKey}"
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const page = await richespay.collections.list({
                limit: 20,
                status: "successful"
              });

              console.log(page.meta.next_starting_after);
            `),
            php: trimCode(`
              <?php

              $ch = curl_init("${apiOrigin}/v1/collections?limit=20&status=successful");
              curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              from urllib import request

              req = request.Request(
                  "${apiOrigin}/v1/collections?limit=20&status=successful",
                  headers={"Authorization": "Bearer ${testSecretKey}"},
                  method="GET",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "checkout-and-payment-links",
    summary: "Hosted checkout keeps card entry off your servers and gives you a short, one-way session flow.",
    title: "Checkout and payment links",
    sections: [
      {
        title: "Create a hosted checkout session",
        paragraphs: [
          "Use a public key for session creation, then redirect the customer to the returned URL.",
          "For payment links, RichesPay creates the session from the link slug and returns a hosted URL."
        ],
        example: {
          title: "Create a checkout session",
          description: "This returns the hosted session URL you send to the browser.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/checkout/sessions" \\
                -H "Authorization: Bearer rp_test_pk_..." \\
                -H "Content-Type: application/json" \\
                -d '{"allowed_methods":["mobile_money","card"],"amount":5000,"currency":"GHS","description":"Checkout payment"}'
            `),
            node: trimCode(`
              const response = await fetch("${apiOrigin}/v1/checkout/sessions", {
                method: "POST",
                headers: {
                  Authorization: "Bearer rp_test_pk_...",
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  allowed_methods: ["mobile_money", "card"],
                  amount: 5000,
                  currency: "GHS",
                  description: "Checkout payment"
                })
              });

              console.log(await response.json());
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "allowed_methods" => ["mobile_money", "card"],
                "amount" => 5000,
                "currency" => "GHS",
                "description" => "Checkout payment"
              ]);

              $ch = curl_init("${apiOrigin}/v1/checkout/sessions");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer rp_test_pk_...",
                  "Content-Type: application/json"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "allowed_methods": ["mobile_money", "card"],
                  "amount": 5000,
                  "currency": "GHS",
                  "description": "Checkout payment",
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/checkout/sessions",
                  data=payload,
                  headers={
                      "Authorization": "Bearer rp_test_pk_...",
                      "Content-Type": "application/json",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "cards-and-refunds",
    summary: "Card collections complete through hosted checkout, while refunds stay on the original collection resource.",
    title: "Cards and refunds",
    sections: [
      {
        title: "Refund from the collection",
        paragraphs: [
          "Refunds live at /collections/:id/refunds so there is one obvious place to start from the original payment.",
          "For partial refunds, send amount in minor units. Omit amount for a full refund."
        ],
        example: {
          title: "Create a refund",
          description: "The same idempotency rule applies to refunds because money is moving.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/collections/col_123/refunds" \\
                -H "Authorization: Bearer ${testSecretKey}" \\
                -H "Content-Type: application/json" \\
                -H "Idempotency-Key: refund-1001" \\
                -d '{"amount":2500}'
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const refund = await richespay.collections.createRefund("col_123", {
                amount: 2500
              }, {
                idempotencyKey: "refund-1001"
              });

              console.log(refund.status);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode(["amount" => 2500]);

              $ch = curl_init("${apiOrigin}/v1/collections/col_123/refunds");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type: application/json",
                  "Idempotency-Key: refund-1001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({"amount": 2500}).encode()
              req = request.Request(
                  "${apiOrigin}/v1/collections/col_123/refunds",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "refund-1001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "payouts-and-bulk-payouts",
    summary: "Single payouts and batches share the same item shape, with phone implying mobile money and bank fields implying bank.",
    title: "Payouts and bulk payouts",
    sections: [
      {
        title: "Create a payout batch",
        paragraphs: [
          "Every payout write needs an Idempotency-Key.",
          "Amounts are always minor units in the merchant settlement currency."
        ],
        example: {
          title: "Submit a payout batch",
          description: "Batch validation comes back in the same data envelope with accepted=false when rows fail preflight checks.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/payout-batches" \\
                -H "Authorization: Bearer ${testSecretKey}" \\
                -H "Content-Type: application/json" \\
                -H "Idempotency-Key: payout-batch-1001" \\
                -d '{"currency":"GHS","reference":"BATCH-1001","items":[{"amount":2000,"phone":"+233241230001","reference":"PAY-1"},{"amount":3500,"phone":"+233241230003","reference":"PAY-2"}]}'
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const batch = await richespay.payoutBatches.create({
                currency: "GHS",
                reference: "BATCH-1001",
                items: [
                  { amount: 2000, phone: "+233241230001", reference: "PAY-1" },
                  { amount: 3500, phone: "+233241230003", reference: "PAY-2" }
                ]
              }, {
                idempotencyKey: "payout-batch-1001"
              });

              console.log(batch);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "currency" => "GHS",
                "reference" => "BATCH-1001",
                "items" => [
                  ["amount" => 2000, "phone" => "+233241230001", "reference" => "PAY-1"],
                  ["amount" => 3500, "phone" => "+233241230003", "reference" => "PAY-2"]
                ]
              ]);

              $ch = curl_init("${apiOrigin}/v1/payout-batches");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type: application/json",
                  "Idempotency-Key: payout-batch-1001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "currency": "GHS",
                  "reference": "BATCH-1001",
                  "items": [
                      {"amount": 2000, "phone": "+233241230001", "reference": "PAY-1"},
                      {"amount": 3500, "phone": "+233241230003", "reference": "PAY-2"},
                  ],
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/payout-batches",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "payout-batch-1001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "sms-and-bulk-sms",
    summary: "Single SMS, bulk SMS, and status reads all live under the same /sms namespace.",
    title: "SMS and bulk SMS",
    sections: [
      {
        title: "Send a bulk SMS batch",
        paragraphs: [
          "Bulk sends cap at 10,000 recipients per request.",
          "The API charges at submission and refunds messages rejected before they reach the network."
        ],
        example: {
          title: "Send transactional SMS in bulk",
          description: "Use your approved sender ID if you need a branded transactional sender.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/sms/bulk" \\
                -H "Authorization: Bearer ${testSecretKey}" \\
                -H "Content-Type: application/json" \\
                -H "Idempotency-Key: sms-batch-1001" \\
                -d '{"message":"Your balance has been updated.","sender_id":"ALERTS","type":"transactional","to":["+233241230001","+233241230002"]}'
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const batch = await richespay.sms.sendBulk({
                message: "Your balance has been updated.",
                sender_id: "ALERTS",
                type: "transactional",
                to: ["+233241230001", "+233241230002"]
              }, {
                idempotencyKey: "sms-batch-1001"
              });

              console.log(batch.batch_id);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "message" => "Your balance has been updated.",
                "sender_id" => "ALERTS",
                "type" => "transactional",
                "to" => ["+233241230001", "+233241230002"]
              ]);

              $ch = curl_init("${apiOrigin}/v1/sms/bulk");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type: application/json",
                  "Idempotency-Key: sms-batch-1001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "message": "Your balance has been updated.",
                  "sender_id": "ALERTS",
                  "type": "transactional",
                  "to": ["+233241230001", "+233241230002"],
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/sms/bulk",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "sms-batch-1001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "otp",
    summary: "OTP uses the same SMS product but gives you a short send and verify pair with attempt limits.",
    title: "OTP",
    sections: [
      {
        title: "Send and verify",
        paragraphs: [
          "Send returns otp_id, sms_id, and expires_at.",
          "Verify returns the status and whether the submitted code matched."
        ],
        example: {
          title: "Send an OTP",
          description: "OTP sends are idempotent because they create a billable SMS.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/otp/send" \\
                -H "Authorization: Bearer ${testSecretKey}" \\
                -H "Content-Type: application/json" \\
                -H "Idempotency-Key: otp-send-1001" \\
                -d '{"expires_in_seconds":300,"length":6,"to":"+233241230001"}'
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const otp = await richespay.otp.send({
                expires_in_seconds: 300,
                length: 6,
                to: "+233241230001"
              }, {
                idempotencyKey: "otp-send-1001"
              });

              console.log(otp.otp_id);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "expires_in_seconds" => 300,
                "length" => 6,
                "to" => "+233241230001"
              ]);

              $ch = curl_init("${apiOrigin}/v1/otp/send");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type: application/json",
                  "Idempotency-Key: otp-send-1001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "expires_in_seconds": 300,
                  "length": 6,
                  "to": "+233241230001",
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/otp/send",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "otp-send-1001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "sender-ids",
    summary: "Sender IDs are approved in the dashboard and admin queue, then referenced from the public SMS API.",
    title: "Sender IDs",
    sections: [
      {
        title: "Use approved sender IDs",
        paragraphs: [
          "Transactional and marketing sender IDs must be approved before public API traffic can use them.",
          "OTP falls back to the platform default sender ID when the merchant does not have an approved OTP sender."
        ],
        example: {
          title: "Send with a sender ID",
          description: "The public API only needs the approved sender_id value.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/sms" \\
                -H "Authorization: Bearer ${testSecretKey}" \\
                -H "Content-Type: application/json" \\
                -H "Idempotency-Key: sender-id-1001" \\
                -d '{"message":"Payment received.","sender_id":"ALERTS","to":"+233241230001","type":"transactional"}'
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const sms = await richespay.sms.send({
                message: "Payment received.",
                sender_id: "ALERTS",
                to: "+233241230001",
                type: "transactional"
              }, {
                idempotencyKey: "sender-id-1001"
              });

              console.log(sms.id);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "message" => "Payment received.",
                "sender_id" => "ALERTS",
                "to" => "+233241230001",
                "type" => "transactional"
              ]);

              $ch = curl_init("${apiOrigin}/v1/sms");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type": "application/json",
                  "Idempotency-Key": "sender-id-1001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "message": "Payment received.",
                  "sender_id": "ALERTS",
                  "to": "+233241230001",
                  "type": "transactional",
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/sms",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "sender-id-1001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "webhooks-and-signature-verification",
    summary: "Treat webhooks as the source of truth for asynchronous status changes and verify the RichesPay-Signature header every time.",
    title: "Webhooks and signature verification",
    sections: [
      {
        title: "Verify the signature header",
        paragraphs: [
          "RichesPay signs the raw request body with t=<unix>,v1=<hex hmac>.",
          "Use your endpoint secret exactly once when the endpoint is created or rolled."
        ],
        example: {
          title: "Verify a webhook signature",
          description: "The Node SDK exposes a verifier that matches the API's signing format.",
          snippets: {
            curl: trimCode(`
              # Webhook verification happens in your application code, not in curl.
              # Keep the raw request body and the RichesPay-Signature header.
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const isValid = richespay.webhooks.verify(
                rawBody,
                request.headers["richespay-signature"],
                "whsec_..."
              );

              if (!isValid) {
                throw new Error("Invalid RichesPay webhook signature");
              }
            `),
            php: trimCode(`
              <?php

              $rawBody = file_get_contents("php://input");
              $signatureHeader = $_SERVER["HTTP_RICHESPAY_SIGNATURE"] ?? "";

              preg_match("/t=(\\d+),v1=([a-f0-9]+)/", $signatureHeader, $matches);
              $timestamp = $matches[1] ?? "";
              $signature = $matches[2] ?? "";
              $expected = hash_hmac("sha256", $timestamp . "." . $rawBody, "whsec_...");

              if (!hash_equals($expected, $signature)) {
                http_response_code(400);
                exit("Invalid signature");
              }
            `),
            python: trimCode(`
              import hashlib
              import hmac
              import re

              raw_body = request_body.decode()
              signature_header = headers.get("RichesPay-Signature", "")
              match = re.search(r"t=(\\d+),v1=([a-f0-9]+)", signature_header)

              if not match:
                  raise ValueError("Missing RichesPay signature")

              timestamp, signature = match.groups()
              expected = hmac.new(
                  b"whsec_...",
                  f"{timestamp}.{raw_body}".encode(),
                  hashlib.sha256,
              ).hexdigest()

              if not hmac.compare_digest(expected, signature):
                  raise ValueError("Invalid signature")
            `)
          }
        }
      }
    ]
  },
  {
    slug: "errors",
    summary: "Every API error uses the same envelope with code, message, optional field, and request_id.",
    title: "Errors",
    sections: [
      {
        title: "Read the error envelope",
        paragraphs: [
          "The HTTP status tells you the class of problem.",
          "The error.code is the stable machine-readable value to branch on."
        ],
        example: {
          title: "Authentication failure example",
          description: "A bad or revoked key returns the same JSON envelope shape as every other API error.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/balance" \\
                -H "Authorization: Bearer rp_test_sk_invalid"
            `),
            node: trimCode(`
              import { RichesPay, RichesPayError } from "@richespay/node";

              const richespay = new RichesPay("rp_test_sk_invalid");

              try {
                await richespay.collections.list();
              } catch (error) {
                if (error instanceof RichesPayError) {
                  console.log(error.code, error.statusCode, error.requestId);
                }
              }
            `),
            php: trimCode(`
              <?php

              $ch = curl_init("${apiOrigin}/v1/balance");
              curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer rp_test_sk_invalid"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              from urllib import error, request

              req = request.Request(
                  "${apiOrigin}/v1/balance",
                  headers={"Authorization": "Bearer rp_test_sk_invalid"},
                  method="GET",
              )

              try:
                  request.urlopen(req)
              except error.HTTPError as exc:
                  print(exc.read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "idempotency",
    summary: "Send Idempotency-Key on every money-moving or SMS-sending write so retries stay safe.",
    title: "Idempotency",
    sections: [
      {
        title: "Reuse the same key for retries",
        paragraphs: [
          "RichesPay stores the first response for the same key and request fingerprint.",
          "Changing the body with the same key returns idempotency_conflict."
        ],
        example: {
          title: "Retry the same payout safely",
          description: "The Node SDK generates Idempotency-Key automatically when you do not pass one.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/payouts" \\
                -H "Authorization: Bearer ${testSecretKey}" \\
                -H "Content-Type: application/json" \\
                -H "Idempotency-Key: payout-1001" \\
                -d '{"amount":2000,"currency":"GHS","phone":"+233241230001","reference":"PAYOUT-1001"}'
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const payout = await richespay.payouts.create({
                amount: 2000,
                currency: "GHS",
                phone: "+233241230001",
                reference: "PAYOUT-1001"
              });

              console.log(payout.id);
            `),
            php: trimCode(`
              <?php

              $payload = json_encode([
                "amount" => 2000,
                "currency" => "GHS",
                "phone" => "+233241230001",
                "reference" => "PAYOUT-1001"
              ]);

              $ch = curl_init("${apiOrigin}/v1/payouts");
              curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}",
                  "Content-Type: application/json",
                  "Idempotency-Key: payout-1001"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              import json
              from urllib import request

              payload = json.dumps({
                  "amount": 2000,
                  "currency": "GHS",
                  "phone": "+233241230001",
                  "reference": "PAYOUT-1001",
              }).encode()

              req = request.Request(
                  "${apiOrigin}/v1/payouts",
                  data=payload,
                  headers={
                      "Authorization": "Bearer ${testSecretKey}",
                      "Content-Type": "application/json",
                      "Idempotency-Key": "payout-1001",
                  },
                  method="POST",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "pagination",
    summary: "Every paginated list uses limit and starting_after, with has_more and next_starting_after in meta.",
    title: "Pagination",
    sections: [
      {
        title: "Use cursor pagination",
        paragraphs: [
          "Cursor pagination is stable under inserts and avoids page-number drift.",
          "The next_starting_after value is always the token you send back on the next request."
        ],
        example: {
          title: "Page through payouts",
          description: "This pattern is the same on collections, payouts, payout batches, and SMS.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/payouts?limit=20&starting_after=pay_01J..." \\
                -H "Authorization: Bearer ${testSecretKey}"
            `),
            node: trimCode(`
              import { RichesPay } from "@richespay/node";

              const richespay = new RichesPay("${testSecretKey}");
              const page = await richespay.payouts.list({
                limit: 20,
                starting_after: "pay_01J..."
              });

              console.log(page.meta.has_more);
            `),
            php: trimCode(`
              <?php

              $ch = curl_init("${apiOrigin}/v1/payouts?limit=20&starting_after=pay_01J...");
              curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              from urllib import request

              req = request.Request(
                  "${apiOrigin}/v1/payouts?limit=20&starting_after=pay_01J...",
                  headers={"Authorization": "Bearer ${testSecretKey}"},
                  method="GET",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  },
  {
    slug: "countries-networks-and-currencies",
    summary: "RichesPay keeps settlement currencies fixed by onboarding country and auto-detects mobile money networks from supported prefixes.",
    title: "Countries, networks and currencies",
    sections: [
      {
        title: "Know the operating rails",
        paragraphs: [
          "Ghana settles in GHS. Zambia settles in ZMW. Other merchant home countries settle in USD.",
          "Mobile money uses the local currency of the wallet country, while card presentment can differ from settlement."
        ],
        example: {
          title: "Quote a collection fee",
          description: "Fee quotes are a quick way to inspect the pricing shape for a route and currency.",
          snippets: {
            curl: trimCode(`
              curl "${apiOrigin}/v1/fees/quote?amount=5000&currency=GHS&kind=collection&method=mobile_money" \\
                -H "Authorization: Bearer ${testSecretKey}"
            `),
            node: trimCode(`
              const response = await fetch("${apiOrigin}/v1/fees/quote?amount=5000&currency=GHS&kind=collection&method=mobile_money", {
                headers: {
                  Authorization: "Bearer ${testSecretKey}"
                }
              });

              console.log(await response.json());
            `),
            php: trimCode(`
              <?php

              $ch = curl_init("${apiOrigin}/v1/fees/quote?amount=5000&currency=GHS&kind=collection&method=mobile_money");
              curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                  "Authorization: Bearer ${testSecretKey}"
                ]
              ]);

              echo curl_exec($ch);
            `),
            python: trimCode(`
              from urllib import request

              req = request.Request(
                  "${apiOrigin}/v1/fees/quote?amount=5000&currency=GHS&kind=collection&method=mobile_money",
                  headers={"Authorization": "Bearer ${testSecretKey}"},
                  method="GET",
              )

              print(request.urlopen(req).read().decode())
            `)
          }
        }
      }
    ]
  }
];

const navigationItems = [
  { href: "/", label: "Overview" },
  ...guides.map((guide) => ({
    href: `/guides/${guide.slug}`,
    label: guide.title
  })),
  { href: "/reference", label: "API reference" },
  { href: "/changelog", label: "Changelog" }
];

const countryRows = [
  {
    country: "Ghana",
    currency: "GHS",
    networks: "MTN MoMo, Telecel Cash, AT Money"
  },
  {
    country: "Zambia",
    currency: "ZMW",
    networks: "MTN MoMo, Airtel Money, Zamtel mobile money"
  }
];

const magicNumberRows = [
  {
    description: "Accepted immediately, then callback succeeds.",
    kind: "Mobile money / bank payout",
    value: "0001"
  },
  {
    description: "Fails immediately with insufficient_funds.",
    kind: "Mobile money / bank payout",
    value: "0002"
  },
  {
    description: "Accepted and stays pending until later status resolution.",
    kind: "Mobile money / bank payout",
    value: "0003"
  },
  {
    description: "Card success.",
    kind: "Card number",
    value: "4000000000000001"
  },
  {
    description: "Card decline.",
    kind: "Card number",
    value: "4000000000000002"
  },
  {
    description: "Card 3-D Secure success.",
    kind: "Card number",
    value: "4000000000000003"
  },
  {
    description: "SMS delivered.",
    kind: "SMS destination",
    value: "0001"
  },
  {
    description: "SMS undelivered.",
    kind: "SMS destination",
    value: "0002"
  },
  {
    description: "SMS rejected.",
    kind: "SMS destination",
    value: "0003"
  }
];

export function App() {
  return (
    <BrowserRouter>
      <DocsLayout />
    </BrowserRouter>
  );
}

function DocsLayout() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">RichesPay</p>
            <h1 className="m-0 text-lg font-semibold text-text">API Docs</h1>
          </div>
          <div className="flex items-center gap-3">
            <a className="text-sm font-medium text-text-secondary no-underline transition hover:text-brand" href={`${apiOrigin}/v1/openapi.json`} rel="noreferrer" target="_blank">
              OpenAPI JSON
            </a>
            <a className="text-sm font-medium text-text-secondary no-underline transition hover:text-brand" href={apiOrigin} rel="noreferrer" target="_blank">
              API Origin
            </a>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-6 py-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:h-fit">
          <div className="rounded-card border border-border bg-white p-4 shadow-sm">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-text-secondary">Guides</p>
            <nav className="flex flex-col gap-1">
              {navigationItems.map((item) => (
                <SidebarLink href={item.href} key={item.href} label={item.label} />
              ))}
            </nav>
          </div>
        </aside>
        <main className="min-w-0">
          <Routes>
            <Route element={<HomePage />} path="/" />
            <Route element={<GuidePage />} path="/guides/:slug" />
            <Route element={<ApiReferencePage />} path="/reference" />
            <Route element={<ChangelogPage />} path="/changelog" />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function SidebarLink({ href, label }: { href: string; label: string }) {
  return (
    <NavLink
      className={({ isActive }) =>
        [
          "rounded-input px-3 py-2 text-sm font-medium no-underline transition",
          isActive ? "bg-brand-50 text-brand" : "text-text-secondary hover:bg-surface-subtle hover:text-text"
        ].join(" ")
      }
      end={href === "/"}
      to={href}
    >
      {label}
    </NavLink>
  );
}

function HomePage() {
  return (
    <div className="space-y-8">
      <section className="rounded-card border border-border bg-white p-8 shadow-sm">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
            Public API
          </span>
          <span className="text-sm text-text-secondary">JSON only, snake_case, minor-unit amounts</span>
        </div>
        <h2 className="m-0 text-4xl font-semibold tracking-tight text-text">A payment and messaging API that stays easy to scan.</h2>
        <p className="mt-4 max-w-3xl text-base text-text-secondary">
          RichesPay keeps the public API small: one base path, one error shape, one pagination pattern, and one idempotency rule for every money or SMS write.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <NavLink className="no-underline" to="/guides/quick-start">
            <Button variant="primary">Read Quick start</Button>
          </NavLink>
          <NavLink className="no-underline" to="/reference">
            <Button variant="secondary">Browse API reference</Button>
          </NavLink>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          {
            body: "Phone defaults to mobile money and network stays optional when RichesPay can infer it.",
            title: "Small requests"
          },
          {
            body: "Every response uses { data, meta? } and every error uses { error: { code, message, field?, request_id? } }.",
            title: "Consistent envelopes"
          },
          {
            body: "cURL, Node, PHP, and Python examples are ready for test mode across the guides.",
            title: "Copy-paste ready"
          }
        ].map((card) => (
          <div className="rounded-card border border-border bg-white p-5 shadow-sm" key={card.title}>
            <h3 className="m-0 text-base font-semibold text-text">{card.title}</h3>
            <p className="mt-2 text-sm text-text-secondary">{card.body}</p>
          </div>
        ))}
      </section>

      <section className="rounded-card border border-border bg-white p-6 shadow-sm">
        <div className="mb-4">
          <h3 className="m-0 text-xl font-semibold text-text">First request</h3>
          <p className="mt-2 text-sm text-text-secondary">
            This is the shortest end-to-end collection example to start with.
          </p>
        </div>
        <CodeBlock code={homeCurlExample} language="bash" />
      </section>
    </div>
  );
}

function GuidePage() {
  const { slug } = useParams();
  const guide = guides.find((entry) => entry.slug === slug);

  if (!guide) {
    return <Navigate replace to="/" />;
  }

  return (
    <div className="space-y-8">
      <section className="rounded-card border border-border bg-white p-8 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-brand">Guide</p>
        <h2 className="m-0 text-3xl font-semibold text-text">{guide.title}</h2>
        <p className="mt-3 max-w-3xl text-base text-text-secondary">{guide.summary}</p>
      </section>

      {guide.slug === "test-mode-and-magic-numbers" ? <MagicNumberTable /> : null}
      {guide.slug === "errors" ? <ErrorsTable /> : null}
      {guide.slug === "countries-networks-and-currencies" ? <CountriesTable /> : null}

      {guide.sections.map((section) => (
        <section className="rounded-card border border-border bg-white p-6 shadow-sm" key={section.title}>
          <h3 className="m-0 text-xl font-semibold text-text">{section.title}</h3>
          <div className="mt-4 space-y-3">
            {section.paragraphs.map((paragraph) => (
              <p className="m-0 text-sm leading-6 text-text-secondary" key={paragraph}>
                {paragraph}
              </p>
            ))}
            {section.bullets ? (
              <ul className="m-0 list-disc pl-5 text-sm leading-6 text-text-secondary">
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </div>
          {section.example ? <div className="mt-6"><ExampleTabs example={section.example} /></div> : null}
        </section>
      ))}
    </div>
  );
}

function ApiReferencePage() {
  return (
    <section className="overflow-hidden rounded-card border border-border bg-white shadow-sm">
      <div className="border-b border-border px-6 py-5">
        <p className="mb-2 text-sm font-semibold text-brand">Reference</p>
        <h2 className="m-0 text-2xl font-semibold text-text">OpenAPI reference</h2>
        <p className="mt-2 text-sm text-text-secondary">
          Rendered directly from <code>/v1/openapi.json</code>.
        </p>
      </div>
      <div className="px-2 pb-2">
        <RedocStandalone
          options={{
            hideDownloadButton: true,
            nativeScrollbars: true,
            theme: {
              colors: {
                primary: {
                  main: "#f97316"
                }
              }
            }
          } as never}
          specUrl={`${apiOrigin}/v1/openapi.json`}
        />
      </div>
    </section>
  );
}

function ChangelogPage() {
  const sections = React.useMemo(() => parseChangelog(changelogMarkdown), []);

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-border bg-white p-8 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-brand">Changelog</p>
        <h2 className="m-0 text-3xl font-semibold text-text">Recent product changes</h2>
        <p className="mt-3 text-base text-text-secondary">
          This page mirrors the project changelog so the docs site keeps shipping notes close to the API reference.
        </p>
      </section>

      {sections.map((section) => (
        <section className="rounded-card border border-border bg-white p-6 shadow-sm" key={section.title}>
          <h3 className="m-0 text-xl font-semibold text-text">{section.title}</h3>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-text-secondary">
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ExampleTabs({ example }: { example: ExampleDefinition }) {
  return (
    <div className="rounded-card border border-border bg-surface-subtle p-4">
      <div className="mb-4">
        <h4 className="m-0 text-base font-semibold text-text">{example.title}</h4>
        <p className="mt-1 text-sm text-text-secondary">{example.description}</p>
      </div>
      <Tabs
        defaultValue="curl"
        items={[
          { content: <CodeBlock code={example.snippets.curl} language="bash" />, label: "cURL", value: "curl" },
          { content: <CodeBlock code={example.snippets.node} language="ts" />, label: "Node", value: "node" },
          { content: <CodeBlock code={example.snippets.php} language="php" />, label: "PHP", value: "php" },
          { content: <CodeBlock code={example.snippets.python} language="python" />, label: "Python", value: "python" }
        ]}
      />
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="overflow-hidden rounded-card border border-slate-900 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">{language}</span>
        <Button onClick={() => void copy()} variant="ghost">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto px-4 py-4 text-sm leading-6 text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ErrorsTable() {
  const rows = Object.entries(ERROR_CATALOG).sort(([left], [right]) => left.localeCompare(right)) as Array<[ErrorCode, (typeof ERROR_CATALOG)[ErrorCode]]>;

  return (
    <section className="rounded-card border border-border bg-white p-6 shadow-sm">
      <h3 className="m-0 text-xl font-semibold text-text">Error catalog</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border text-text-secondary">
              <th className="px-3 py-2 font-medium">Code</th>
              <th className="px-3 py-2 font-medium">HTTP status</th>
              <th className="px-3 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([code, definition]) => (
              <tr className="border-b border-border/70 align-top" key={code}>
                <td className="px-3 py-3 font-mono text-xs text-text">{code}</td>
                <td className="px-3 py-3 text-text">{definition.status}</td>
                <td className="px-3 py-3 text-text-secondary">{definition.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CountriesTable() {
  return (
    <section className="rounded-card border border-border bg-white p-6 shadow-sm">
      <h3 className="m-0 text-xl font-semibold text-text">Launch countries and networks</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border text-text-secondary">
              <th className="px-3 py-2 font-medium">Country</th>
              <th className="px-3 py-2 font-medium">Settlement currency</th>
              <th className="px-3 py-2 font-medium">Mobile money networks</th>
            </tr>
          </thead>
          <tbody>
            {countryRows.map((row) => (
              <tr className="border-b border-border/70" key={row.country}>
                <td className="px-3 py-3 text-text">{row.country}</td>
                <td className="px-3 py-3 text-text">{row.currency}</td>
                <td className="px-3 py-3 text-text-secondary">{row.networks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MagicNumberTable() {
  return (
    <section className="rounded-card border border-border bg-white p-6 shadow-sm">
      <h3 className="m-0 text-xl font-semibold text-text">Simulator shortcuts</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border text-text-secondary">
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Value</th>
              <th className="px-3 py-2 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {magicNumberRows.map((row, index) => (
              <tr className="border-b border-border/70" key={`${row.kind}-${index}`}>
                <td className="px-3 py-3 text-text">{row.kind}</td>
                <td className="px-3 py-3 font-mono text-xs text-text">{row.value}</td>
                <td className="px-3 py-3 text-text-secondary">{row.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function parseChangelog(markdown: string) {
  const sections: Array<{ items: string[]; title: string }> = [];
  let current: { items: string[]; title: string } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = {
        items: [],
        title: line.replace(/^##\s+/, "").trim()
      };
      sections.push(current);
      continue;
    }

    if (line.startsWith("- ") && current) {
      current.items.push(line.replace(/^- /, "").trim());
    }
  }

  return sections;
}

function trimCode(value: string) {
  const lines = value.replace(/^\n/, "").split("\n");
  const indent = Math.min(
    ...lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^ */)?.[0].length ?? 0)
  );

  return lines.map((line) => line.slice(indent)).join("\n").trim();
}
