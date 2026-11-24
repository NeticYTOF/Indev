 ▄▄▄ ▄▄   ▄▄ ▄▄▄▄   ▄▄▄▄▄ ▄▄   ▄▄
  █  ██▄  ██ ██ ▀█  ██▄▄  ▀█▄ ▄█▀
  █  ██ ▀▄██ ██  █  ██      ▀█▀
 ▀▀▀ ▀▀   ▀▀ ▀▀▀▀   ▀▀▀▀▀    ▀

indev is an ev route planner for india. you type where your starting and where your going, pick your car and how much battery you have, and it plans the whole trip with real charging stops pulled live from statiq chargers along the way. its like abrp but made for indian roads and indian cars, with a pure black amoled look and a little mascot called chhotu who reacts to everything you do.

how to use it. just open https://indeev.vercel.app in any browser, on your phone or your laptop. thats it, nothing to install. type a from and a to, drag the battery gauge to your current charge and hit plan. youll get the route on the map, every charging stop in order, how long each leg is and roughly what battery youll have when you arrive.

how to run it on your own pc. you need node 20 or newer installed, get it from nodejs.org if you dont have it. then clone https://github.com/NeticYTOF/Indev.git, go into the folder and run npm install. copy .env.example to .env and put your statiq token in STATIQ_API_TOKEN, then run npm run dev and open http://localhost:5173. the token stays on the server side only, its never sent to the browser and never logged. if you dont have a token run npm run dev:stack instead, that starts a mock version with fake chargers so you can play around, and everything is clearly labeled synthetic data so you never mistake it for real.

the cars. it comes with 8 indian market evs, the tata harrier ev 75, tata curvv ev 55, tata punch ev lr 35, tata tiago ev 24, mahindra be6 79, mg zs ev 50, mg comet ev 17 and hyundai ioniq 5 72. the company range claims are kept seperate from your own real world range, so you can tell it how far your car actually goes and it plans with that instead of the brochure number.

tap any charging stop, on the map or in the plan list, and a sheet slides up with that chargers details, its plugs, its power, the battery you arrive with and leave with, and where the info came from. between stops theres little distance pills so you can see how far each hop is at a glance.

there are 2 search modes. smart is the default, it checks the most promising chargers first so you get a plan fast. thorough checks way more chargers along the route, its slower but it leaves less on the table.

ai planning is there too but you bring your own key. open the ai settings, pick a provider (hack club ai, openai, openrouter, groq or google gemini), paste your key and optionally write your own custom instructions like avoid slow chargers or i want a long lunch stop. your key is encrypted and stored on your device only. it gets sent along with your ai plan requests and thats it, the server uses it for that one run and never saves it or logs it. the ai only picks between real chargers the planner already found, it cant make up stations.

saved trips. on the website your trips are saved in your own browser, so they stay on that device. when you run it on your own pc the trips are saved on the server and shared with the mcp server, so an ai assistant can see them too.

the keyboard shortcuts are simple. press / to jump to the from box, up and down arrows move through suggestions, enter picks or plans, esc closes things and ? shows the shortcut card. theres also a couple of hidden easter eggs, try typing chai.

the mcp server. if you use an ai assistant that speaks mcp you can hook indev up to it and it gets 3 tools, plan_trip, list_saved_trips and get_station. start it with node node_modules/tsx/dist/cli.mjs apps/mcp/src/index.ts, dont use the npm shortcut on windows because it can drop your env vars.

the limits on the website. its running on the free vercel plan so every plan has to finish within 300 seconds, really long thorough or ai searches can hit that wall. theres no background jobs, a plan runs in one go. saved trips dont sync between devices. and the charger counter can reset whenever vercel spins up a fresh server.

how it was all achieved. the whole thing is typescript. the planning lives in packages/core, it talks to the statiq charger api through a cloudflare worker, gets the road route from osrm and turns place names into coordinates with photon. it scans a corridor along the route for chargers, works out the battery for every leg and picks stops that actually get you there, and if it cant prove a plan works it says so honestly instead of guessing. apps/server is the api built on hono, apps/web is the website drawn with maplibre on a dark openfreemap map with zero gradients and a lot of motion, and apps/mcp is the mcp server. the hosted version bundles the server into one file with esbuild and runs it as a vercel function, with the website served next to it. charger data is always fetched live, only a count of chargers seen is ever stored, never the station data itself, and the logs never contain tokens, coordinates or your route.

the docs folder has the deep dives, how many requests a plan costs, the trip briefing and export, editing saved routes, the charger evidence panel and comparing two saved trips.

testing. npm test runs the tests, npm run typecheck checks the types and npm run test:browser runs the browser checks on a mock stack (run npm run test:browser:setup once first).

this project was create 100% by ai although i have put in my own efforts in this and this is not slop nor is it one shot.
