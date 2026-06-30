# Send Tokens

Idea for when I have more Claude to burn:

What if cards can need send tokens to send a message? This doesn’t need to be enforced on chain to avoid transaction costs, it’s just a UUID that a wallet needs to invalidate in order to send a message. 

A cardholder can request an unlimited number of send tokens (which triggers an on-chain transaction). The number that they requested and when they made the request is then publicly affiliated with their card (perhaps as a log entry? Perhaps as something else, though a log entry goes privacy nicely.) 

Perhaps this happens in a directory on chain. It lists mutable pointers along with a list of send token requests both for that card and for its child cards. Times are vague (just dates), so cards and child cards can’t be correlated through time logs unless they use non-rounded numbers. Default is a request of 100 send tokens at a time, so there’s no incentive to use these non-standard numbers.

This makes it easy to see if a card is spammy. 