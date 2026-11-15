"""Extend places.json with a spread of US places: every lower-48 state, the large metros, and basins known for groundwater
or oil-and-gas pumping. The list is from general knowledge of where people and pumping are; whether a place is sinking is
whatever the radar then shows. Run once:  .venv/Scripts/python strainwatch/build/gen_places.py
"""
import json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
P = os.path.join(HERE, "places.json")
ST = {"pinal": "AZ", "sanjoaquin": "CA", "houston": "TX", "lasvegas": "NV", "aguascalientes": "MX", "celaya": "MX", "elnido": "CA", "kern": "CA", "sacramento": "CA",
      "coachella": "CA", "antelope": "CA", "tucson": "AZ", "mcmullen": "AZ", "sansimon": "AZ", "cedar": "UT", "pecos": "TX", "elpaso": "TX", "neworleans": "LA", "norfolk": "VA"}
STATE = {"AL": "Alabama", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida",
         "GA": "Georgia", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
         "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
         "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
         "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
         "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming"}
# id, name, area, state, lat, lon
NEW = """
seattle|Seattle|King County|WA|47.58|-122.30
spokane|Spokane|Spokane Valley|WA|47.66|-117.38
portland|Portland|Willamette Valley|OR|45.52|-122.66
losangeles|Los Angeles|Long Beach and the LA basin|CA|33.90|-118.20
sanjose|San Jose|Santa Clara Valley|CA|37.36|-121.92
oakland|East Bay|Oakland and Hayward|CA|37.72|-122.15
sacramentocity|Sacramento|Sacramento and the Delta edge|CA|38.55|-121.45
sandiego|San Diego|San Diego County|CA|32.76|-117.10
fresno|Fresno|Fresno County|CA|36.70|-119.85
stockton|Stockton|San Joaquin Delta|CA|37.95|-121.33
losthills|Lost Hills|Belridge and Lost Hills oil fields|CA|35.55|-119.72
pasorobles|Paso Robles|Salinas Valley head|CA|35.65|-120.62
oxnard|Oxnard|Oxnard Plain|CA|34.20|-119.15
imperial|Imperial Valley|El Centro|CA|32.82|-115.52
reno|Reno|Truckee Meadows|NV|39.52|-119.80
pahrump|Pahrump|Pahrump Valley|NV|36.20|-115.99
boise|Boise|Treasure Valley|ID|43.60|-116.25
idahofalls|Idaho Falls|Eastern Snake River Plain|ID|43.50|-112.05
billings|Billings|Yellowstone County|MT|45.78|-108.52
cheyenne|Cheyenne|Laramie County|WY|41.14|-104.80
saltlake|Salt Lake City|Salt Lake Valley|UT|40.72|-111.92
beryl|Escalante Valley|Beryl and Enterprise|UT|37.78|-113.66
denver|Denver|Denver Basin|CO|39.74|-104.95
sanluis|San Luis Valley|Alamosa|CO|37.55|-105.90
coloradosprings|Colorado Springs|El Paso County|CO|38.84|-104.78
yuma|Yuma|Yuma Valley|AZ|32.68|-114.60
douglas|Douglas Basin|Elfrida and McNeal|AZ|31.58|-109.65
harquahala|Harquahala Plain|La Paz and Maricopa counties|AZ|33.45|-113.15
albuquerque|Albuquerque|Middle Rio Grande Basin|NM|35.10|-106.62
deming|Deming|Mimbres Basin|NM|32.25|-107.75
lascruces|Las Cruces|Mesilla Valley|NM|32.32|-106.78
carlsbad|Carlsbad|Delaware Basin|NM|32.40|-104.20
dallas|Dallas|Dallas County|TX|32.80|-96.80
fortworth|Fort Worth|Tarrant County|TX|32.75|-97.32
sanantonio|San Antonio|Bexar County|TX|29.45|-98.50
austin|Austin|Travis County|TX|30.28|-97.74
lubbock|Lubbock|Southern High Plains|TX|33.58|-101.87
midland|Midland and Odessa|Permian Basin|TX|31.92|-102.22
corpuschristi|Corpus Christi|Nueces County|TX|27.78|-97.42
baytown|Baytown and Galveston Bay|East Harris County|TX|29.68|-95.08
conroe|The Woodlands and Conroe|Montgomery County|TX|30.24|-95.48
mcallen|McAllen|Lower Rio Grande Valley|TX|26.22|-98.22
amarillo|Amarillo|Texas Panhandle|TX|35.20|-101.83
oklahomacity|Oklahoma City|Central Oklahoma|OK|35.47|-97.52
tulsa|Tulsa|Tulsa County|OK|36.14|-95.97
wichita|Wichita|Sedgwick County|KS|37.69|-97.34
gardencity|Garden City|High Plains aquifer|KS|37.97|-100.87
omaha|Omaha|Douglas County|NE|41.25|-95.95
siouxfalls|Sioux Falls|Minnehaha County|SD|43.55|-96.73
fargo|Fargo|Red River Valley|ND|46.87|-96.80
williston|Williston|Bakken oil field|ND|48.15|-103.62
minneapolis|Minneapolis and St Paul|Twin Cities|MN|44.96|-93.20
desmoines|Des Moines|Polk County|IA|41.59|-93.62
stlouis|St. Louis|Mississippi River valley|MO|38.63|-90.22
kansascity|Kansas City|Jackson County|MO|39.10|-94.58
littlerock|Little Rock|Pulaski County|AR|34.74|-92.29
stuttgart|Grand Prairie|Stuttgart|AR|34.50|-91.55
batonrouge|Baton Rouge|East Baton Rouge Parish|LA|30.45|-91.12
lakecharles|Lake Charles|Calcasieu Parish|LA|30.22|-93.22
jackson|Jackson|Hinds County|MS|32.30|-90.18
birmingham|Birmingham|Jefferson County|AL|33.52|-86.80
mobile|Mobile|Mobile Bay|AL|30.69|-88.08
memphis|Memphis|Shelby County|TN|35.13|-90.00
nashville|Nashville|Davidson County|TN|36.16|-86.78
louisville|Louisville|Jefferson County|KY|38.24|-85.74
chicago|Chicago|Cook County|IL|41.85|-87.70
milwaukee|Milwaukee|Milwaukee County|WI|43.04|-87.95
detroit|Detroit|Wayne County|MI|42.35|-83.10
indianapolis|Indianapolis|Marion County|IN|39.77|-86.16
columbus|Columbus|Franklin County|OH|39.97|-83.00
cleveland|Cleveland|Cuyahoga County|OH|41.46|-81.70
cincinnati|Cincinnati|Hamilton County|OH|39.12|-84.52
pittsburgh|Pittsburgh|Allegheny County|PA|40.44|-79.98
philadelphia|Philadelphia|Delaware Valley|PA|39.95|-75.17
newyork|New York City|Five boroughs and Newark|NY|40.72|-74.00
buffalo|Buffalo|Erie County|NY|42.89|-78.85
atlanticcity|Atlantic City|New Jersey shore|NJ|39.38|-74.48
boston|Boston|Greater Boston|MA|42.35|-71.08
hartford|Hartford|Connecticut River valley|CT|41.76|-72.68
providence|Providence|Narragansett Bay|RI|41.80|-71.42
portlandme|Portland|Casco Bay|ME|43.67|-70.28
burlington|Burlington|Chittenden County|VT|44.47|-73.18
manchester|Manchester|Merrimack Valley|NH|42.98|-71.45
washington|Washington|District of Columbia|DC|38.90|-77.03
baltimore|Baltimore|Patapsco River|MD|39.28|-76.60
wilmington|Wilmington|New Castle County|DE|39.72|-75.56
richmond|Richmond|James River|VA|37.53|-77.45
charlestonwv|Charleston|Kanawha Valley|WV|38.36|-81.65
charlotte|Charlotte|Mecklenburg County|NC|35.22|-80.84
raleigh|Raleigh|Wake County|NC|35.80|-78.65
charlestonsc|Charleston|Charleston Harbor|SC|32.82|-79.96
columbiasc|Columbia|Richland County|SC|34.00|-81.03
atlanta|Atlanta|Fulton County|GA|33.76|-84.40
savannah|Savannah|Chatham County|GA|32.06|-81.12
miami|Miami|Miami-Dade County|FL|25.80|-80.25
tampa|Tampa|Tampa Bay|FL|27.95|-82.48
orlando|Orlando|Orange County|FL|28.52|-81.38
jacksonville|Jacksonville|Duval County|FL|30.32|-81.66
phoenixcentral|Phoenix|Central Phoenix and Tempe|AZ|33.45|-112.02
""".strip().splitlines()

places = json.load(open(P))
for k, st in ST.items():
    places[k]["st"] = st
rows = [r.split("|") for r in NEW]
random.Random(7).shuffle(rows)  # so that whatever has finished at any moment is spread across the country
added = 0
for pid, name, area, st, lat, lon in rows:
    if pid in places:
        continue
    lat, lon = float(lat), float(lon)
    places[pid] = dict(name=name, region=f"{area}, {STATE[st]}", box=[round(lon - 0.18, 3), round(lon + 0.18, 3), round(lat - 0.15, 3), round(lat + 0.15, 3)],
                       center=[lon, lat], zoom=10.8, st=st, **({"az": True} if st == "AZ" else {}))
    added += 1
json.dump(places, open(P, "w"), indent=1)
states = {v["st"] for k, v in places.items() if not k.startswith("_") and v.get("st") not in (None, "MX")}
print("added", added, "| total places in file", len(places) - 1, "| US states and DC with a place:", len(states) + 0)
