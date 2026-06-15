# About The Digital Neighborhood Protocol

The Digital Neighborhood Protocol is designed to help communities securely share resources and build trust online. With it, community members can easily prove their affiliation to others, gain access to resources for the community, and create those resources themselves.

DNP is a decentralized protocol similar to Web of Trust, with a few small differences that make it easier for communities to use. It is built around a set of digital identity tokens called badges. Each badge is represented by a signed attestation stored on IPFS. To prove that they hold a badge, a community member must sign a statement with the private key tied to that badge.

DNP is designed to provide the following assurances:

1. Each badge is tied to a chain of verifications. It is easy to see who granted a badge and why that badge was granted, who granted the badge granters badge, and so on.
2. Badges are updatable and revocable.
3. By default, revealing a badge reveals nothing about the badge holder other than the information that the badge verifies.
4. Badges can send and receive messages. This allows for secure communication using a badge’s public key without the need to reveal a potentially identifying communications channel, such as an email address.
5. Badges are not discoverable unless they are shared.
6. Badges are hosted on fully decentralized infrastructure governed by a protocol governance board. 

This document will walk through how badges are used and verified, created, and updated or revoked.

# Use Cases

Badges have two primary use cases:

## Attestation

Badges can be used to attest that a particular statement is trustworthy. For example, a high school student reaching out to an LGBTQ center may provide proof that they go to a local high school without otherwise revealing their identity. They would do so by signing a message to the LGBT center and providing a pointer to a badge granted by their high school. The LGBT center could then communicate with them directly via their badge.

## Verification

Badges can be used to access conversations and resources designed for particular communities. For example, the youth director of the LGBT center may grant the student a “Queer Youth Group” badge. This would grant them access to chat rooms, a community calendar, and a Minecraft server for queer kids in the area. These services could all be hosted on different platforms and use a simple NPM package to verify badges and grant entry. With a little vibe coding experience, the student could create their own community resource and share it with the group.

# Verification

When the LGBT youth director receives the high school student’s badge, software on their mobile device receives four things:

1. A message
2. A signature of that message
3. A public key tied to that signature

The youth director’s mobile device confirms that the signature is valid, then derives a smart contract address from the public key. It fetches the smart contract address, which points to a CDN on IPFS which can be decrypted with the high school student’s public key. This yields the following:

1. A verified statement, e.g. “The holder of this badge is registered as a student at MLK High School.”
2. A link the the smart contract address of a policy which granted this badge, in this case a policy created by the school superintendent for granting badges to high school students, and the appropriate key to read it.
3. A link to the person who enacted that policy to create this badge, in this case a school administrator for MLK High.
4. An https endpoint which can receive messages. This is tied to a wallet service which holds the user’s keys.
5. A link to an image stored in IPFS used to display the badge.
6. An array of addresses and keys representing the full badge lineage of both the school superintendent and the school administrator. For example, the school superintendent’s badge may have a lineage that looks like this:
    1. A root badge run by the DPN governing authority.
    2. A badge run by a system which confirms domain names via TXT files.
    3. A badge which confirms ownership of the local school district website.
    4. A badge for the CTO of the local school district.
    5. A badge for the school superintendent.
7. An array of notes appended to the student’s badge. According to school policy, these are updated only with significant behavior violations and significant achievements. In this case, the badge proves that the student is first chair in the orchestra.
    1. This information is enough information to de-anonymize them, but in this case the student is comfortable with that risk. Sometimes students come to the LGBT center with anonymized badges. Students will show their badge to a notary service and receive back a badge that says “I attest that I have seen this individual show a badge granted by the high school student badge creation policy. If major behavior issues exist, they fall in the following categories.” They then take this badge to the LGBT center to prove that they are students without further revealing their identity.

The youth director’s mobile device walks the chain of attestation to confirm that everything is in good working order. The badges along the chain all check out, no one has reported that their private keys have been stolen or left their job before granting the appropriate badges. The student’s badge appears with a green check card in the corner, and the youth director can click on it to view the history if he likes.

# Badge Granting

The youth director then goes to grant the student a “Queer Youth Group” badge. On their mobile device they select a badge granting policy that was created by their executive director. This includes the following:

1. A link to the executive director’s badge.
2. A set of constraints on the badges that this policy is allowed to create. For example, they must be titled “Queer Youth Club Member”, and they must be granted to someone who has a badge from a local high school or an appropriate anonymization service.
3. A set of constraints for who can enact the policy. 
    1. In this case, anyone with a “LGBT Center Youth Director” badge, which only the youth director possesses.
4.  A link to a set of badges who have permission to update or revoke this badge. 
    1. In this case anyone with a badge granted by the “LGBT Center Staff” badge creation policy can update but only the Youth Director and ED can revoke.
5. A link to a set of badges who have permission to audit logs about this badge.
    1. In this case the youth director, the executive director, and an external verifier which generates reports for the LGBT Center’s funders.
6. A set of constraints on the policies that this badge is allowed to create.
    1. In this case, the “Queer Youth Group” badge is not allowed to create policies to grant additional badges.
7. A set of presses that are approved to finalize the badge (more on this later).

The youth director clicks the policy and drags the student’s badge into it. Sometimes badge creation requires him to fill out additional fields, but in this case the high school student badge is all that he needs. His system confirms that the newly created badge meets the policy, creates a JSON blob similar to the high school student badge, and signs it with his Youth Director badge. His system then encrypts it with the public key of the high school student badge sends it to that badge’s address.

The high school student gets a notification on their phone that they have received a new badge. They see that their high school badge received a message from the LGBT center that they reached out to, and that the incoming message has a new badge attached to it. They’d love to see what the center has to offer, so they click accept. Their device asks them to verify with facial recognition, and they see a check card that the badge has been accepted.

When they click accept, their device uses biometric authorization to create a new ML-DSA-44 private key in the on-device secure enclave. This key is larger and takes a bit longer to create, but ensures that the badge is resistant to decryption by quantum computers in the future. It signs the badge offer sent by the Youth Director with this new private key, attaches the associated public key and an address where the badge can receive messages, and sends it back to the Youth Director’s badge address. 

It also activates a backup process. Biometric authorization is used to generate a private key that encrypts the new badge’s new private key and uploads it to a wallet service. The private key that can decrypt the wallet can be created on any device where they can log in to their Apple account (or Google account if they are an Android user) and go through biometric authentication. If they are security minded or worried about losing access to their Apple account they can also require any combination of a YubiKey, paper password, or other standard security practice to decrypt their wallet backup. Once they have defined a wallet policy, the right combination of these services will be sufficient to find and decrypt their wallet backups even if their wallet service is compromised.

The badge offer with the new public key and signature attached goes back to the Youth Director. Their device receives the package, confirms that the signatures check out, and automatically sends it to one of the approved badge presses listed with the badge. Because the new badge doesn’t include a link to the high school badge (doing so would de-anonymize the high school student) their system also includes a link to that badge for verification purposes.

When the LGBT Center’s CTO set up the badge system, they selected two well-respected presses and put $50 into each to cover badge creation costs for the next few years. Both presses had plenty of rave reviews signed by badges from third party auditors, so they were easy to trust. 

The press receives the policy signed by both the youth director and the student, along with supplemental data in the form of the high school student’s badge. It goes through the verification process for the high school student, badge creation policy, and Youth Director badge to ensure all badges involved are legit. It checks to confirm that the new badge meets the criteria of the badge policy: it has an allowed name,  the person it is being granted by and granted to meet policy requirements, etc. 

Since everything checks out, it signs the badge creation blob with its press badge, encrypts the resulting blob to be readable with the new badgeholder’s public key, and posts it to IPFS. It discards information about the high school student badge, since this is sensitive and not included in the new Queer Youth Group badge. It then registers the resulting CDN on a smart contract, associating it with a mutable pointer derived from the badge’s public key. 

The press service sends the CDN to the smart contract along with a link to the policy used to create the badge and a small amount of Eth to cover gas costs. The smart contract contains a register of approved presses for each policy and each badge. The smart contract confirms that this press is approved to create new badges for this policy and registers the new mutable pointer.

The press then messages both the Youth Director and the new badgeholder to let them know that the badge registration process is complete. It charges the LGBTQ center’s account for the both the gas cost and a small margin, about $0.05 total. Competition among presses keeps this cost low.

# Badge Updating and Revocation

Once they see that the badge has been completed, the Youth Director’s device sends an automatic message the new community member welcoming them and letting them know what the community has to offer. They link to a community calendar that only badge holders can see and post to, a set of chatrooms that only badge holders can access, a private Bluesky-like feed for the community and a few vibe-coded projects that youth group members have put together. 

As the youth group member navigates these spaces, everything they do is tracable back to their badge. If they behave inappropriately, anyone who they have shown their badge can message the Youth Director with statements that the group member has made signed by their badge, allowing the Youth Director to take appropriate action. In extreme cases, the Youth Director could forward the message on to the High School Administrator’s badge with appropriate context.

Thankfully, the new member fits well into the group. They start supporting others, and after a few months earn a position of respected leadership in the group. The Youth Director decides to update their badge to reflect this new position of trust, so that the group member can approach other organizations doing queer youth work in the future and prove that they are worthy of respect. 

They draft a brief note explaining the new leadership role and give it an update status code. In this case the code is in the 200 range- an update denoting an increase in trust that does not alter a badge’s properties. Now if anyone verifies the badge they will see both a green checkmark and a little green “1”, prompting them to see the reasons why this badge is especially trustworthy. The Youth Director sends the update to the press along with the badge’s public key.

The press retrieves and verifies the badge, confirms that the update aligns with the badge’s update policy, then creates a new version of the badge with the update appended. It posts this to IPFS, gets a new CDN, then updates the badge’s mutable pointer registered with the smart contract. The smart contract confirms that the press is authorized to make updates for this badge before letting the update through. 

A quick note on presses: These run on verified open source code that is regularly vetted by third parties. A press could presumably create false badges and post their mutable pointers to the smart contract, but because these badges would lack a verification chain they would be easily detectable by verifiers. Posting such false badges would threaten the press’s reputation. The press verification step conducted by the smart contract exists to stop a malicious actor from spinning up unverified presses and spamming the registry with false updates to make verification difficult.

Several years later, the group member is ready to age out of the program. The original Youth Director has left and a new one has been hired, but the badge update policy still recognizes this new badge because it was created with the appropriate policy. If necessary, the ED can also always update the badge creation policy using a similar process to the one described above to allow new categories of staff members to make updates.

The new Youth Director assigns the group member a new “Queer Youth Group Alumni” badge which will allow them to participate in the alumni community. The Youth Director then prepares an update with a code in the 800 range, a silent revocation. She selects attaches a note indicating that the group member is aging out in good standing, adds a link to the new alumni badge, and sends the update to the press. The press confirms that the new Youth Director is allowed to make 800-range updates, then pushes the update to IPFS and the smart contract.

Now when someone verifies the Youth Group badge the badge will appear in grey with a little arrow in the corner. Someone clicking on the badge can see when and why it was revoked along with a link to the associated alumni badge. Services which used to grant access with the badge will see the 800 range update and refuse to do so.

In extreme cases the Youth Director could also engage in a 900 range update, a loud revocation. Say that a malicious actor had somehow gained access to a high school student badge and used it to try to gain access to the queer youth community in ways that could cause harm. A 900 range revocation would proactively notify anyone who had interacted with the badge to stop trusting it. If the badge had been used in association with other badges (say, in a chat the badge holder had shown both their queer youth group badge and a badge showing membership in an anime fan club) people who had witnessed both badges would be prompted to pass on the revocation to the anime fan club. 900-range revocations would generally be tied to concrete evidence of some kind- either statements signed by the badge in question or statements about offline behavior signed by well-trusted parties. Both 800 and 900-range revocations can be backdated, essentially saying “consider anything signed by this badge after the following date invalid.” It would be up to people receiving news of this revocation to review the evidence and decide what action to take.

# Additional Notes

## Open Offers and New Wallets

In the scenario above a student uses one badge to gain another, but how does the student receive their first badge?

An Open Offer is a policy which can be claimed by anyone who accesses a URL. It can be embedded in a QR code or sent via E-mail or SMS. It is tied to a badge policy similar to the one described above, with additional limits on how it can be accepted (for example, it can only be accepted a certain number of times or cannot be accepted after a certain timestamp.)

When a user clicks an open offer, they are linked to a recommended badge service. The service displays the badge being offered with some explanatory texts and asks them if they would like to accept it. If they would, they authenticate with a biosignature to create a new keypair for the badge and initiate the creation of a new wallet, which is also backed up. The new wallet sends the accepted offer back to the badgeholder who granted it, and the process proceeds as normal.

The new wallet will also register on device to receive URLs with dnp:// as a prefix. This will allow third party services to message the wallet to ask for badge verification. For example, if the user tries to access a Minecraft server the server may make a request to a dnp:// address which says the equivalent of “I’m looking for a badge generated by the Queer Youth Group policy, if this user has one please prompt them to sign this entry protocol with it and I’ll grant them access.” 

The creator of a new Open Offer policy must accept from one of a set of wallet services approved by the Protocol governing board. This requirement is verified by presses and by anyone viewing a badge created by an open offer. This prevents malicious actors from pointing new users to a wallet service that will steal their data. 

## Software Ecosystem

The badge ecosystem would be supported by a set up open source software packages maintained by the Protocol governing board. This would consist of:

1. NPM and python packages for easily handling badge verification and communication that could be easily integrated into web and mobile apps. 
2. A separate open source wallet-handling package which handles keystore creation, backup, and restoration as well as policy creation, badge offer creation, badge acceptance and update authorship. Anyone can develop wallets with this package, but wallet developers must be verified by the Protocol governing board in order to be included in open offers and to send and receive messages. Any verified wallet who sees a badge which receives messages via an unverified wallet will notify the Protocol governing board.
    1. This package would include a series of docker containers for receiving wallet backups, handling restoration, sending and receiving badge messages, and pinning recently accessed badges on IPFS to ensure redundancy. 
3. An open source package for running presses.  This would cover the ability to verify that new badges and updates meet policy, post to IPFS, update the smart contract, and hold the funds necessary to do so. 
4. A smart contract, hosted on Arbitrum One, which registers mutable badges and presses qualified to update them. A set of updatable smart wallets would govern who is allowed to make updates to this contract, approve new presses, and approve new wallet services.

## Known Vulnerabilities

1. **A Malicious Actor Could Gain Access to A User’s Badge Keys**
    1. This would be difficult if the keys are stored on a private enclave, but not impossible. For example, if a malicious actor was able to gain access to a user’s Apple account and fake or compel a biosignature.
    2. In this scenario, a malicious actor could falsely sign statements, falsely grant new badges, and decrypt and view the message and activity history associated with the compromised badges. 
    3. In the event that this malicious actor was discovered, the discovery could be announced via a 900 range revocation backdated to the time when key compromise occurred.
2. **A Malicious Actor Could De-Anonymize a User Who Posts In Public with Multiple Badges**
    1. If a user posts publicly with multiple badges those badges could be associated in ways that could potentially de-anonymize the user. The best way to address this vulnerability is to make these public links transparent. When clicking on a badge, a user should see information about the other badges that it is already publicly associated with, and when posting publicly with a badge they should be asked if they want to associate it with their other public posts or use a badge anonymization service.
3. **A Malicious Actor Could Recruit Users To A Wallet Which Steals Their Data, But Only If It Kept Them Isolated**
    1. This would be difficult, and would require the following steps:
        1. The malicious actor would need to create a press in good standing with the Protocol Governance Board.
        2. The malicious actor would need to create a compromised, unregistered wallet service and use it to generate an open offer.
        3. The compromised but trusted press would register the open offer on the smart contract. Because the smart contract only checks that a press is verified and cannot see details of a badge or policy this would be allowed.
        4. The malicious actor could then grant a badge to their compromised wallet, and potentially use this badge to grant additional badges. The compromised wallet could surveil the user and sign false statements on their behalf.
        5. If at any point the user shows any of their badges to anyone using standard verification packages, such as by trying to access a site or message a user not in the compromised network, the Protocol Governance Board would be notified.
        6. The governance board would then revoke the rights of the compromised press so that it could no longer generate false badges. All holders of badges created by this press would be notified and given instructions to relocate to a verified wallet service, though the compromised wallet service would be in a position to suppress this message. 
4. **A Malicious Actor could fool the Protocol governing board to create wallet services or presses which contain malicious code.**
    1. This will require sufficient systems of transparency between the governing board and wallet and press implementers.
5. **A Malicious actor could grant a badge, then revoke it with a 900-range update under false pretenses.**
    1. This attack is limited by the malicious actor’s capacity to attach compelling evidence to the revocation, but is a real threat.