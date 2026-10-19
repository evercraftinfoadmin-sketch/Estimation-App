"use strict";

/* The single calculation engine. Every screen, saved record, print and email
   uses computeEstimateTotals(); nothing else does estimate math.

   line total   = quantity × price
   subtotal     = sum of all category totals (Drywall, Stucco, Painting + custom categories)
   markupAmount = subtotal × markup% / 100
   taxAmount    = taxableAmount × taxRate / 100
                  (taxableAmount = subtotal + markup, or subtotal only — see Settings)
   grandTotal   = subtotal + markupAmount + taxAmount
*/
function computeEstimateTotals({items, markup, taxRate, taxMode}){
  const categoryTotals={};
  MAIN_CATEGORY_KEYS.forEach(k=>{ categoryTotals[k]=0; });

  const lines=(items||[])
    .filter(it=>it && it.category)
    .map(it=>{
      const quantity=amount(it.quantity);
      const price=amount(it.price);
      const total=round2(quantity*price);
      categoryTotals[it.category]=round2((categoryTotals[it.category]||0)+total);
      return {...it,quantity,price,total};
    });

  const subtotal=round2(Object.values(categoryTotals).reduce((sum,v)=>sum+v,0));
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

/* What the client sees: markup and sales tax are built into each line's price, so documents
   for the client (print, PDF, email, signing) show only prices and the total, "all taxes
   included". The markup stays internal. Line totals add up exactly to the grand total (any
   rounding cent goes to the largest line). */
function clientPricedLines(items, grandTotal){
  const base=items.reduce((s,it)=>s+(Number(it.total)||0),0);
  const factor=base>0 ? grandTotal/base : 1;
  const out=items.map(it=>{
    const total=round2((Number(it.total)||0)*factor);
    const qty=Number(it.quantity)||0;
    return {...it, total, price:qty ? total/qty : total};
  });
  const diff=round2(grandTotal-out.reduce((s,it)=>s+it.total,0));
  if(diff && out.length){
    const i=out.reduce((m,it,k)=>it.total>out[m].total ? k : m,0);
    out[i]={...out[i], total:round2(out[i].total+diff)};
    const q=Number(out[i].quantity)||0;
    out[i].price=q ? out[i].total/q : out[i].total;
  }
  return out;
}

// A client unit price: cents, or up to 4 decimals when cents would not multiply to the line total.
function clientUnitPrice(it){
  const cents=round2(it.price);
  if(round2(cents*(Number(it.quantity)||0))===round2(it.total)) return money(cents);
  const s=(Math.round(it.price*10000)/10000).toFixed(4).replace(/0+$/,"").replace(/\.$/,"");
  return "$"+Number(s).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:4});
}
