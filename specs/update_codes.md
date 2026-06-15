1xx - Positive Card Update
 - The user has earned additional trust and is linking to a new card as a result. Viewers of this card should be aware of the increased trust that the user has earned (e.g. an employee has been promoted.)
2xx - Positive Context
 - A note is being added to the card that indicates that the user is deserving of additional trust, but no change to the card is taking place.
3XX - Neutral Update
 - There is a neutral update to the card, such as a refresh of a valid_until date.
 - This update is relevant to someone understanding the trustworthiness of the card but is neither positive nor negative (e.g. this person remains an active member of our community.) 
4xx - Neutral Context
 - Information is being added which is neutral but pertinent context for verifiers.
5xx - Programmatic Update
 - Updates to the card that are triggered automatically for programmatic reasons and bear no reflection on the trustworthiness of the card.
6XX - Negative Context
 - A note that could imply that the card is less trustworthy, but that does not warrant revocation.
7XX - Negative Update
 - The card is being updated in ways that reduce its privileges (e.g. admin rights are being removed).
 - This may or may not imply that the card holder is less trustworthy, this can be expressed by subcode (e.g. a 710 may mean that some has termed out of a particular responsibility but is still in good standing, while a 760 may be more of a dishonorable discharge.)
 - In general, lower numbers imply more trustworthy, higher numbers imply less trustworthy, and numbers in the middle are neutral. So a 750 would be “rights are being removed from this card for entirely procedural reasons” while a 710 would be “this person is retiring their rights after exemplary service”.
8XX - Quiet revocation
 - This card is being revoked. Anyone directly accessing this card should know about it, but the card holder does not pose an active risk to other communities.
 - E.g. the card holder is leaving a job. The key of only this card has been compromised.
9xx - Loud Revocation
 - This card is being revoked, and the holder of the card may pose risks to other communities who should be noted accordingly.
 - If someone runs a community where people show multiple cards and a member gets a 9XX revocation, the individual involved may want to consider passing the revocation on to issuers of other cards that they have seen this person use.
 - E.g. This person’s entire wallet has been compromised. This person is a bad actor utilizing this card under false and potentially harmful pretenses.