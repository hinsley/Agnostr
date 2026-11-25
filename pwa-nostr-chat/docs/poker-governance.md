# Room Poker membership

A seat belongs to its room-scoped signing key. Groups use the account key
and Bitchat channels use the channel identity. At least three seats are
needed to vote anyone out. Removal requires more than half of **all**
occupied seats; the target cannot vote for their own removal. A vote covers
one table, one room, one roster revision and one target. Seat changes reset
the vote. No dealer assent is needed.

Informed clients calculate a departure from independently signed ballots
(or the departing seat's signed leave). If the dealer departs, the
lowest-numbered remaining seat takes over. A live hand is canceled and the
remaining seats recover their own committed chips, since the old dealer
held the private deck. The table closes only when its last seat leaves.
Accepted expulsions are stored locally and the current dealer does not
reseat the expelled key. The new dealer retransmits up to 16 signed
transition proofs for clients with the prior matching roster who missed a
live vote. New clients ignore old host-only end messages.

This is not Byzantine consensus or identity verification. Older clients do
not implement this protocol; a new browser without the original roster
must rely on the announced live dealer. Proofs are not a durable relay
history. An accepted ban or resulting dealer survives a same-browser
reload when local storage is available, but unobserved transitions, relay
partitions, competing roster changes and new pseudonyms are not resolved
by the ban. Poker chips here are in-app game state.
