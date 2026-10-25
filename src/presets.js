'use strict';

/**
 * Chat presets for SettleSloth demonstration, testing, and evaluation.
 * Each preset represents a realistic, multi-line group chat dump with
 * various challenges: Hinglish phrasing, shorthand amounts (e.g. 2.4k),
 * explicit exclusions, direct repayments, and ambiguous claims.
 */

const PRESETS = [
  {
    id: 'goa-trip',
    title: 'Goa Weekend Trip (12 msgs - Hinglish + Exclusions + Ambiguity)',
    description:
      '4 friends in Goa with shorthand amounts (2.4k), exclusions (skipping Aman for watersports), GPay repayments, and uncertain scooter petrol.',
    participants: ['Rahul', 'Priya', 'Aman', 'Neha'],
    text: `Rahul: Paid 1500 for airport cab to Calangute hotel
Priya: Lunch at Tito's was 1800, paid by card
Neha: Got snacks and beers for 850 from supermarket
Rahul: Paid 2.4k for beach shack dinner last night
Aman: Chalo ready in 10 mins for watersports
Priya: Paid 4000 for scuba package, don't count Aman he didn't do watersports
Aman: I sent Rahul 500 on GPay yesterday for breakfast
Neha: Maybe 350 for scooter petrol? Need to check receipt
Rahul: Added 1200 for beach umbrella and sunbeds
Neha: Goa sunsets are amazing guys
Priya: Dinner at fisherman's wharf was 3100, paid via UPI
Aman: Super fun trip, let's settle balances tonight`
  },
  {
    id: 'bengaluru-flatmates',
    title: 'Bengaluru Flatmates Monthly Dump (10 msgs)',
    description:
      '3 flatmates splitting electricity, Wi-Fi, maid salary, Instamart groceries, and an uncertain water cans bill.',
    participants: ['Arjun', 'Sneha', 'Vikram'],
    text: `Arjun: Paid electricity bill 1450 on Bescom app
Sneha: Paid ACT wifi 1199 for this month
Vikram: Paid maid salary 3000 cash for October
Sneha: Swiggy Instamart groceries came to 1650
Arjun: Water cans maybe 240? Need to verify delivery card
Vikram: Maid asked if we can pay newspaper bill too
Sneha: Sent Vikram 1000 on PhonePe for maid advance
Arjun: Bought kitchen cleaning supplies for 420
Vikram: Ordered drinking water 20L cans 180 yesterday
Sneha: Shared the Instamart invoice in our email group`
  },
  {
    id: 'hackathon-run',
    title: 'Hackathon Team Midnight Run (8 msgs)',
    description:
      '3 hackathon teammates splitting pizza, Red Bull energy drinks, cab home, and an ambiguous surge fee.',
    participants: ['Dev', 'Tara', 'Kabir'],
    text: `Dev: Ordered Domino's pizza for 1400 during coding sprint
Tara: Bought Red Bulls and snacks for 650 at 2am
Kabir: Paid 950 for cab to the hackathon venue this morning
Dev: Late night Uber surge was around 220 extra? Not sure if included in receipt
Tara: Sent Dev 400 via UPI for midnight coffees
Kabir: Printouts for project poster was 180
Dev: Mentor loved our open-weight Gemma architecture!
Tara: Submitting on Devpost now, let's settle the food tab`
  }
];

/**
 * Retrieve a preset by its unique ID.
 * @param {string} id - Preset identifier (e.g., 'goa-trip')
 * @returns {object|null} The preset object or null if not found
 */
function getPresetById(id) {
  return PRESETS.find((preset) => preset.id === id) || null;
}

/**
 * Retrieve all available presets.
 * @returns {Array<object>} List of preset objects
 */
function getAllPresets() {
  return PRESETS;
}

module.exports = {
  PRESETS,
  getPresetById,
  getAllPresets
};
