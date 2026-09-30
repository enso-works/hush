---
description: Install and wire hush (@bavrk/hush) in the app in the current directory
argument-hint: "[url] [key]"
disable-model-invocation: true
---

Install hush in the app in the current directory by delegating to the
hush:installer agent.

Arguments, as typed (the hush server URL, then the prod write key; either may
be missing): $ARGUMENTS

Before delegating:

1. If the server URL or the prod write key is missing from the arguments, ask
   the user for it. If the key typed has `_dev_` in it (`hush_<app>_dev_…`),
   it is the dev key: ask for the prod key. Also ask whether they have a dev
   write key, and whether they want feedback screens, RevenueCat `identify()`,
   or iOS ad attribution with `@bavrk/hush-expo` (and if so, the domain for
   `attributionEndpoint`). Never invent a URL or a key. If the user wants to go
   ahead with only a dev key, tell the agent so: it leaves the prod key empty,
   which keeps release builds off. If the user wants the wiring before the
   server exists, tell the agent so: it writes `url: ''` and an empty key,
   which keeps the SDK off. The agent lists what is missing as still to do.
2. Delegate to the hush:installer agent with the URL, the keys, and the
   optional parts the user chose.
3. If the agent returns asking for something, ask the user and run it again
   with the answer.
4. Show the agent's report to the user as it is. Do not commit.
