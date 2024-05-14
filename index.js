const express = require('express');
const app = express();
require('dotenv').config();
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const port = process.env.PORT || 8000;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
let nodemailer = require("nodemailer");


// middleware
const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));


// verifyToken
const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token
  console.log(token)
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err)
      return res.status(401).send({ message: 'unauthorized access' })
    }
    req.user = decoded
    next()
  })
}


// send email
const sendEmail = (emailAddress, emailData) => {
  // create a transporter
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.APP_USER,
      pass: process.env.APP_PASS,
    }

  });

  // verify transporter
  transporter.verify((error, success) => {
    if (error) {
      console.log(error)
    }
    if (success) {
      console.log("success gmail: ", success)
    }
  });


  const mailBody = {
    from: process.env.APP_USER,
    to: emailAddress,
    subject: emailData?.subject,
    html: `<P>${emailData?.message}</p>`
  };

  transporter.sendMail(mailBody, (error, info) => {
    if (error) {
      console.log(error)
    }
    if (info) {
      console.log('Email sent : ', info.response)
    }
  })


}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.of0ix0q.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {

    const database = client.db('stayVistaDb');
    const usersCollection = database.collection('users');
    const roomsCollection = database.collection('rooms');
    const bookingsCollection = database.collection('bookings');


    // verify admins
    const verifyAdmin = async (req, res, next) => {
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== 'admin') {
        return res.status(401).send({ message: "Unauthorized" });
      }
      else {
        next();
      }
    };
    // verify hosts
    const verifyHost = async (req, res, next) => {
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== 'host') {
        return res.status(401).send({ message: "Unauthorized" });
      }
      else {
        next();
      }
    };



    // auth related api
    app.post('/jwt', async (req, res) => {
      const user = req.body
      console.log('I need a new jwt', user)
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '24h',
      })
      res
        .cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
        })
        .send({ success: true })
    })

    // Logout
    app.get('/logout', async (req, res) => {
      try {
        res
          .clearCookie('token', {
            maxAge: 0,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
          })
          .send({ success: true })
        console.log('Logout successful')
      } catch (err) {
        res.status(500).send(err)
      }
    })

    // Save or modify user email, status in DB
    app.put('/users/:email', async (req, res) => {
      const email = req.params.email
      const user = req.body
      const query = { email: email }
      const options = { upsert: true }
      const isExist = await usersCollection.findOne(query)
      console.log('User found?----->', isExist)
      if (isExist) {
        if (user?.status === 'Requested') {
          const result = await usersCollection.updateOne(query, { $set: user }, options);
          return res.send(result);
        } else {
          return res.send({ message: 'exist' });
        }
      };
      const result = await usersCollection.updateOne(
        query,
        {
          $set: { ...user, timestamp: Date.now() },
        },
        options
      )
      res.send(result)
    })

    // get role of user
    app.get('/user/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email: email });
      res.send(result);
    });


    // get all rooms 
    app.get('/rooms', verifyToken, async (req, res) => {
      const result = await roomsCollection.find().toArray();
      res.send(result);
    });

    // get host rooms
    app.get('/rooms/:email', verifyToken, verifyHost, async (req, res) => {
      const email = req.params.email;
      const query = {
        'host.email': email
      };

      const result = await roomsCollection.find(query).toArray();
      res.send(result);
    });


    // get single room
    app.get('/room/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await roomsCollection.findOne(query);
      res.send(result);
    });

    // add room data
    app.post('/rooms', verifyToken, verifyHost, async (req, res) => {
      const data = req.body;
      const result = await roomsCollection.insertOne(data);
      res.send(result);
    })






    // create payment intent
    app.post('/create-payment-intent', verifyToken, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      if (!price || amount < 1) {
        return res.status(400).send('no money !!!')
      };
      const { client_secret } = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        'payment_method_types': ['card'],
      });

      res.send({ clientSecret: client_secret });
    });


    // save bookings
    app.post('/bookings', verifyToken, async (req, res) => {
      const bookingInfo = req.body;
      const result = await bookingsCollection.insertOne(bookingInfo);
      if (result?.insertedId) {
        // send email to guest
        sendEmail(bookingInfo?.guest?.email, {
          subject: 'Booking Successful!',
          message: `Room Ready, chole ashen vai, apnar Transaction Id: ${bookingInfo.transactionId}`,
        })


        // send email to host
        sendEmail(bookingInfo?.host, {
          subject: 'Booking Successful!',
          message: `Room Ready, chole ashen vai, apnar Transaction Id: ${bookingInfo.transactionId}`,
        })
      }
      res.send(result);
    });

    // update rooms
    app.patch('/rooms/status/:id', async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          booked: status,
        },
      };
      const result = await roomsCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // get all bookings data for guest
    app.get('/bookings', verifyToken, async (req, res) => {
      const { email } = req.query;
      if (!email) {
        return res.send([]);
      };

      const query = { 'guest.email': email };

      const result = await bookingsCollection.find(query).toArray();
      res.send(result);

    });

    // get all bookings data for host
    app.get('/bookings/host', verifyToken, verifyHost, async (req, res) => {
      const { email } = req.query;
      if (!email) {
        return res.send([]);
      };

      const query = { host: email };

      const result = await bookingsCollection.find(query).toArray();
      res.send(result);

    });

    // get all users
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    })


    // update user role
    app.put('/users/update/:email', verifyToken, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email: email };
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          ...user,
          timestamp: Date.now(),
        },
      };

      const result = await usersCollection.updateOne(query, updateDoc, options);

      res.send(result);
    })


    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from StayVista Server..')
})

app.listen(port, () => {
  console.log(`StayVista is running on port ${port}`)
})
