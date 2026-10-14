// All money is integer paise. Fee uses basis points with half-up rounding in pure integer math.
function isPaise(n) { return Number.isSafeInteger(n) && n >= 0; }

function calcFee(requestedPaise, feeBps) {
  return Math.floor((requestedPaise * feeBps + 5000) / 10000);
}

function calcWithdrawal(requestedPaise, feeBps) {
  const fee = calcFee(requestedPaise, feeBps);
  return { fee, net: requestedPaise - fee };
}

module.exports = { isPaise, calcFee, calcWithdrawal };
