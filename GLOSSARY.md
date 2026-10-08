# Usage Pace

Usage Pace distinguishes reported quota exhaustion from forecasts of future exhaustion, and optional limit resets from scheduled quota renewals.

## Language

**Quota window**:
A provider-reported usage allowance that renews at a scheduled reset. An account may have overlapping session, weekly, or model-specific windows.

**Limit reset**:
An optional, provider-granted opportunity to replenish a usage allowance outside its scheduled renewal. A limit reset has a provider-defined scope, such as full or five-hour, and may expire if unused.

**Reset grant**:
A provider-issued allowance for one or more optional limit resets, with its own scope, validity period, and conditions.

**Saved reset balance**:
The number of unused resets held in an account's active grants. Holding a reset does not necessarily mean it can be redeemed immediately.
_Avoid_: Available resets, when referring only to a saved balance

**Reset availability**:
Whether the provider currently permits a limit reset to be redeemed. Availability can depend on quota exhaustion or account eligibility and is distinct from a saved reset balance.

**Confirmed exhaustion**:
A quota window reported by the provider as fully consumed. A forecast alone does not confirm exhaustion.
_Avoid_: Estimated exhaustion

**Projected exhaustion**:
The forecast time when a quota window would be fully consumed at the observed usage rate. Passing that time does not establish confirmed exhaustion.

**Reset countdown**:
The time until the latest scheduled reset among an account's exhausted quota windows. It describes reported quota renewal, not a guarantee that every model or service will become available.
