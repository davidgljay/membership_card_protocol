# Open Questions

* Could I use Cloudflare durable objects to have relays be server less as well? That would let me maintain a more consistent architecture.
  * Looks like the answer is yes, and it would save me from having to maintain a server for relays. Worth a refactor to save the $/month. Then every piece of infrastructure can be hosted for free. 