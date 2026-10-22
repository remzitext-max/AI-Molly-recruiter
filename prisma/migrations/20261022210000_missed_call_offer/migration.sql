-- Second missed-call text (the offer), sent right after the first one.
ALTER TABLE "SystemSetting" ADD COLUMN     "missedCallSmsOffer" TEXT NOT NULL DEFAULT '';

-- The owner's wording (2026-10-22), only where the old default text was never edited.
UPDATE "SystemSetting" SET "missedCallSmsText" = 'Good part of the day {name}
It is {persona}
Trucking company "TBT EXPRESS INC"
You have applied for {position} position
Could not reach you out, offer will be sent below
Once you have free time, feel free to reach me out
Reply STOP to opt out' WHERE "missedCallSmsText" = '{company} recruiting team: Hi {first}, it''s {persona}. We just tried to call you about the truck driving job you applied for. When is a good time to call you back? Reply STOP to opt out.';
UPDATE "SystemSetting" SET "missedCallSmsOffer" = 'Requirements:
- Minimum 2 year of CDL Class A driving experience
- Clean MVR, PSP, and Clearinghouse preferred
- Available to start ASAP (start date negotiable)
- Professional attitude and commitment to safety

Compensation:
- 80 CPM - Without cab camera
- 85 CPM - With Cab camera

Equipment:
- 2022-2026 Freightliner and Volvo trucks
- Equipped with inverter, microwave, and refrigerator
- Clean, reliable, and well-maintained equipment

Freight:
- Dry Van only
- Live Loads
- Drop & Hook
- Running all 48 states

What We Offer:
- 24/7 professional dispatch support
- Paid loaded and empty miles
- Weekly direct deposit every Friday
- No escrow
- No payment hold after the initial week
- Inspection bonuses
- Company-owned maintenance shop
- Fuel card provided
- 1099 position

Home Time:
- 3 weeks OTR = 3 days home
- 4 weeks OTR = 4 days home
- 5+ weeks OTR = 6 days home

Additional Benefits:
- Paid parking during home time when applicable

Best Regards,
Recruiting Department' WHERE "missedCallSmsOffer" = '';
