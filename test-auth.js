// A simple script to test our backend endpoints locally

async function runTests() {
    console.log("🚀 Starting Authentication API Tests...");

    // 1. DATA FOR A NEW LOCAL OWNER IN EL CHOCÓ ANDINO
    const newOwner = {
        name: "Luis Vargas",
        email: "luis@chocoandino.com",
        password: "securePassword456",
        role: "owner"
    };

    // 2. TEST THE REGISTER ENDPOINT (POST)
    try {
        console.log("\n--- Testing Registration ---");
        const registerResponse = await fetch('http://localhost:3000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newOwner)
        });

        const registerData = await registerResponse.json();
        console.log(`Status Code: ${registerResponse.status}`);
        console.log("Server Response:", registerData);

    } catch (error) {
        console.error("Registration test failed to connect to server:", error.message);
    }

    // 3. TEST THE LOGIN ENDPOINT (POST)
    try {
        console.log("\n--- Testing Login ---");
        const loginResponse = await fetch('http://localhost:3000/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: newOwner.email,
                password: newOwner.password
            })
        });

        const loginData = await loginResponse.json();
        console.log(`Status Code: ${loginResponse.status}`);
        console.log("Server Response:", loginData);

        if (loginResponse.status === 200 && loginData.token) {
            console.log("\n✅ SUCCESS! Received a digital passport token stamped with JWT_SECRET.");
        } else {
            console.log("\n❌ FAILED! Did not receive a login token.");
        }

    } catch (error) {
        console.error("Login test failed to connect to server:", error.message);
    }
}

runTests();
