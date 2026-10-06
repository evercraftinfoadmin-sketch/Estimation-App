"use strict";

/* The single calculation engine. Every screen, saved record, print and email
   uses computeEstimateTotals(); nothing else does estimate math.

   line total   = quantity × price
   subtotal     = drywall + stucco + painting totals
   markupAmount = subtotal × markup% / 100
   taxAmount    = taxableAmount × taxRate / 100
                  (taxableAmount = subtotal + markup, or subtotal only — see Settings)
   grandTotal   = subtotal + markupAmount + taxAmount
*/
function computeEstimateTotals({items, markup, taxRate, taxMode}){
  const categoryTotals={};
  CATEGORY_KEYS.forEach(k=>{ categoryTotals[k]=0; });

  const lines=(items||[])
    .filter(it=>CATEGORY_KEYS.includes(it.category))
    .map(it=>{
      const quantity=amount(it.quantity);
      const price=amount(it.price);
      const total=round2(quantity*price);
      categoryTotals[it.category]=round2(categoryTotals[it.category]+total);
      return {...it,quantity,price,total};
    });

  const subtotal=round2(CATEGORY_KEYS.reduce((sum,k)=>sum+categoryTotals[k],0));
  const markupPercent=amount(markup);
  const markupAmount=round2(subtotal*markupPercent/100);
  const rate=amount(taxRate);
  const mode=taxMode==="subtotal" ? "subtotal" : "all";
  const taxableAmount=mode==="subtotal" ? subtotal : round2(subtotal+markupAmount);
  const taxAmount=round2(taxableAmount*rate/100);
  const grandTotal=round2(subtotal+markupAmount+taxAmount);

  return {
    items:lines,
    categoryTotals,
    subtotal,
    markup:markupPercent,
    markupAmount,
    taxRate:rate,
    taxMode:mode,
    taxableAmount,
    taxAmount,
    grandTotal
  };
}
