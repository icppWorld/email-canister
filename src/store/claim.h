// What a pump's claim on its next piece of work found

#pragma once

namespace store {

// Again: the claim settled the item itself, for instance by quarantining it,
// and the pump can go on at once
enum class Claim { Empty, Again, Claimed, Failed };

} // namespace store
